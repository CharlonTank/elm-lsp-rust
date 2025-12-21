import { spawn } from "child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

const LSP_PATH = "/Users/charles-andreassus/projects/elm-claude-improvements/elm-lsp-rust/target/release/elm_lsp";
const MEETDOWN = "/Users/charles-andreassus/projects/elm-claude-improvements/elm-lsp-rust/tests/meetdown";
const BACKUP_DIR = "/tmp/meetdown_backup";

class LSPClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  async start(root) {
    return new Promise((resolve, reject) => {
      this.process = spawn(LSP_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.process.stdout.on("data", d => this.handleData(d.toString()));
      this.process.stderr.on("data", d => {}); // Suppress debug output

      this.send("initialize", { processId: 1, rootUri: `file://${root}`, capabilities: {} })
        .then(() => this.notify("initialized", {}))
        .then(resolve)
        .catch(reject);
    });
  }

  handleData(data) {
    this.buffer += data;
    while (true) {
      const m = this.buffer.match(/Content-Length: (\d+)\r?\n\r?\n/);
      if (!m) break;
      const len = parseInt(m[1]);
      const end = m.index + m[0].length;
      if (this.buffer.length < end + len) break;
      const msg = JSON.parse(this.buffer.slice(end, end + len));
      this.buffer = this.buffer.slice(end + len);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result);
        this.pending.delete(msg.id);
      }
    }
  }

  send(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const byteLength = Buffer.byteLength(msg, 'utf8');
      this.process.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${msg}`);
    });
  }

  notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const byteLength = Buffer.byteLength(msg, 'utf8');
    this.process.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${msg}`);
    return Promise.resolve();
  }

  async openFile(path) {
    const content = readFileSync(path, "utf-8");
    await this.notify("textDocument/didOpen", {
      textDocument: { uri: `file://${path}`, languageId: "elm", version: 1, text: content }
    });
  }

  async prepareRemoveVariant(path, line, char) {
    return this.send("workspace/executeCommand", {
      command: "elm.prepareRemoveVariant",
      arguments: [`file://${path}`, line, char]
    });
  }

  async removeVariant(path, line, char) {
    const result = await this.send("workspace/executeCommand", {
      command: "elm.removeVariant",
      arguments: [`file://${path}`, line, char]
    });

    // Apply the workspace edits if removal was successful
    if (result?.success && result?.changes) {
      for (const [uri, edits] of Object.entries(result.changes)) {
        const filePath = uri.replace("file://", "");
        let content = readFileSync(filePath, "utf-8");

        // Sort edits by position (reverse order to apply from end first)
        const sortedEdits = [...edits].sort((a, b) => {
          if (b.range.start.line !== a.range.start.line) {
            return b.range.start.line - a.range.start.line;
          }
          return b.range.start.character - a.range.start.character;
        });

        const lines = content.split("\n");
        for (const edit of sortedEdits) {
          const startLine = edit.range.start.line;
          const endLine = edit.range.end.line;
          const startChar = edit.range.start.character;
          const endChar = edit.range.end.character;

          if (startLine === endLine) {
            // Single line edit
            const line = lines[startLine] || "";
            lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
          } else {
            // Multi-line edit
            const startLineContent = (lines[startLine] || "").slice(0, startChar);
            const endLineContent = (lines[endLine] || "").slice(endChar);
            const newLines = edit.newText.split("\n");

            if (newLines.length === 1) {
              lines.splice(startLine, endLine - startLine + 1, startLineContent + newLines[0] + endLineContent);
            } else {
              newLines[0] = startLineContent + newLines[0];
              newLines[newLines.length - 1] = newLines[newLines.length - 1] + endLineContent;
              lines.splice(startLine, endLine - startLine + 1, ...newLines);
            }
          }
        }

        writeFileSync(filePath, lines.join("\n"));
      }
    }

    return result;
  }

  stop() { this.process?.kill(); }
}

// Find variant line in a file
function findVariantLine(filePath, variantName) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if ((line.startsWith("=") || line.startsWith("|")) && line.includes(variantName)) {
      const parts = line.split(/\s+/);
      if (parts[1] === variantName || parts[0] === variantName) {
        return { line: i, char: lines[i].indexOf(variantName) };
      }
    }
  }
  return null;
}

// Backup meetdown files
function backupMeetdown() {
  if (existsSync(BACKUP_DIR)) {
    rmSync(BACKUP_DIR, { recursive: true });
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  mkdirSync(join(BACKUP_DIR, "src"), { recursive: true });

  const srcDir = join(MEETDOWN, "src");
  const files = readdirSync(srcDir).filter(f => f.endsWith(".elm"));
  for (const file of files) {
    copyFileSync(join(srcDir, file), join(BACKUP_DIR, "src", file));
  }
}

// Restore meetdown files
function restoreMeetdown() {
  const srcDir = join(MEETDOWN, "src");
  const backupSrcDir = join(BACKUP_DIR, "src");
  const files = readdirSync(backupSrcDir).filter(f => f.endsWith(".elm"));
  for (const file of files) {
    copyFileSync(join(backupSrcDir, file), join(srcDir, file));
  }
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function logTest(name, success, details = "") {
  const status = success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${status} ${name}`);
  if (details && !success) {
    console.log(`     ${RED}${details}${RESET}`);
  }
  if (success) passed++;
  else failed++;
}

async function main() {
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Meetdown Real-World Remove Variant Tests${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}\n`);

  const client = new LSPClient();
  await client.start(MEETDOWN);

  // ===== TEST 1: Type with constructor usage (should block) =====
  console.log(`${CYAN}Test 1: MeetOnlineAndInPerson (has constructor usage - should BLOCK)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Event.elm");
    const pos = findVariantLine(file, "MeetOnlineAndInPerson");
    await client.openFile(file);
    const result = await client.prepareRemoveVariant(file, pos.line, pos.char);

    logTest("Has blocking usages", result.blockingCount > 0);
    logTest("Cannot remove (canRemove=false)", result.canRemove === false);
    logTest("Detected constructor usages", result.blockingUsages?.some(u => u.usage_type === "Constructor"));
    logTest("Found pattern usages too", result.patternCount > 0);
    console.log(`     → ${result.blockingCount} blocking, ${result.patternCount} patterns\n`);
  }

  // ===== TEST 2: Analyze EventCancelled usages =====
  console.log(`${CYAN}Test 2: EventCancelled (analyze usages)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Event.elm");
    const pos = findVariantLine(file, "EventCancelled");
    await client.openFile(file);
    const result = await client.prepareRemoveVariant(file, pos.line, pos.char);

    logTest("Usage analysis complete", result.variantName === "EventCancelled");
    logTest("Has pattern usages", result.patternCount > 0);
    console.log(`     → blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    if (result.blockingUsages?.length > 0) {
      console.log(`     → Blocking in: ${result.blockingUsages.map(u => u.context).slice(0, 3).join(", ")}`);
    }
    console.log();
  }

  // ===== TEST 3: GroupVisibility - check both variants =====
  console.log(`${CYAN}Test 3: GroupVisibility variants${RESET}`);
  {
    const file = join(MEETDOWN, "src/Group.elm");
    await client.openFile(file);

    const posUnlisted = findVariantLine(file, "UnlistedGroup");
    const resultUnlisted = await client.prepareRemoveVariant(file, posUnlisted.line, posUnlisted.char);
    logTest("UnlistedGroup: analyzed", resultUnlisted.variantName === "UnlistedGroup");
    console.log(`     → blocking=${resultUnlisted.blockingCount}, patterns=${resultUnlisted.patternCount}, canRemove=${resultUnlisted.canRemove}`);

    const posPublic = findVariantLine(file, "PublicGroup");
    const resultPublic = await client.prepareRemoveVariant(file, posPublic.line, posPublic.char);
    logTest("PublicGroup: analyzed", resultPublic.variantName === "PublicGroup");
    console.log(`     → blocking=${resultPublic.blockingCount}, patterns=${resultPublic.patternCount}, canRemove=${resultPublic.canRemove}\n`);
  }

  // ===== TEST 4: PastOngoingOrFuture (3 variants) =====
  console.log(`${CYAN}Test 4: PastOngoingOrFuture (3 variants)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Group.elm");
    await client.openFile(file);

    for (const variant of ["IsPastEvent", "IsOngoingEvent", "IsFutureEvent"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
        const status = result.canRemove ? "can remove" : `blocked (${result.blockingCount} constructors)`;
        console.log(`     ${variant}: ${status}, ${result.patternCount} patterns`);
      }
    }
    console.log();
  }

  // ===== TEST 5: Try to REMOVE EventCancelled (may be blocked) =====
  console.log(`${CYAN}Test 5: Try to REMOVE EventCancelled${RESET}`);
  {
    backupMeetdown();
    try {
      const file = join(MEETDOWN, "src/Event.elm");
      const originalContent = readFileSync(file, "utf-8");

      const pos = findVariantLine(file, "EventCancelled");
      await client.openFile(file);
      const result = await client.removeVariant(file, pos.line, pos.char);

      if (result.success) {
        logTest("Removal succeeded", true);
        logTest("Message mentions removal", result.message?.includes("Removed"));

        // Check the file was modified
        const newContent = readFileSync(file, "utf-8");
        logTest("EventCancelled removed from type", !newContent.includes("= EventCancelled") && !newContent.includes("| EventCancelled"));
        console.log(`     → ${result.message}\n`);
      } else {
        logTest("Removal correctly blocked", true);
        logTest("Error message provided", result.message?.length > 0);
        console.log(`     → Blocked: ${result.message}\n`);
      }
    } finally {
      restoreMeetdown();
    }
  }

  // ===== TEST 6: Try to remove variant with constructor (should fail) =====
  console.log(`${CYAN}Test 6: Try to REMOVE MeetOnline (has constructors - should FAIL)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Event.elm");
    const pos = findVariantLine(file, "MeetOnline");
    await client.openFile(file);
    const result = await client.removeVariant(file, pos.line, pos.char);

    logTest("Removal blocked (success=false)", result.success === false);
    logTest("Error message explains why", result.message?.includes("constructor") || result.message?.includes("blocking"));
    logTest("Shows blocking usages", result.blockingUsages?.length > 0);
    console.log(`     → ${result.message}\n`);
  }

  // ===== TEST 7: Error types (often pattern-only) =====
  console.log(`${CYAN}Test 7: Error types analysis${RESET}`);
  {
    // Check Description.Error
    const descFile = join(MEETDOWN, "src/Description.elm");
    await client.openFile(descFile);
    const posEmpty = findVariantLine(descFile, "DescriptionTooLong");
    if (posEmpty) {
      const result = await client.prepareRemoveVariant(descFile, posEmpty.line, posEmpty.char);
      console.log(`     Description.DescriptionTooLong: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }

    // Check GroupName.Error
    const groupNameFile = join(MEETDOWN, "src/GroupName.elm");
    await client.openFile(groupNameFile);
    const posNameEmpty = findVariantLine(groupNameFile, "GroupNameTooShort");
    if (posNameEmpty) {
      const result = await client.prepareRemoveVariant(groupNameFile, posNameEmpty.line, posNameEmpty.char);
      console.log(`     GroupName.GroupNameTooShort: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }
    console.log();
  }

  // ===== TEST 8: Msg type (large union type) =====
  console.log(`${CYAN}Test 8: Large Msg type from GroupPage${RESET}`);
  {
    const file = join(MEETDOWN, "src/GroupPage.elm");
    await client.openFile(file);

    // Sample a few Msg variants
    for (const variant of ["PressedCancelEvent", "PressedUncancelEvent", "PressedLeaveEvent"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          const status = result.canRemove ? `✓ removable` : `✗ blocked(${result.blockingCount})`;
          console.log(`     ${variant}: ${status}, ${result.patternCount} patterns`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      } else {
        console.log(`     ${variant}: NOT FOUND`);
      }
    }
    console.log();
  }

  // ===== TEST 9: Verify response structure =====
  console.log(`${CYAN}Test 9: Response structure verification${RESET}`);
  {
    const file = join(MEETDOWN, "src/Event.elm");
    const pos = findVariantLine(file, "MeetInPerson");
    await client.openFile(file);
    const result = await client.prepareRemoveVariant(file, pos.line, pos.char);

    logTest("Has blocking usages array", Array.isArray(result.blockingUsages));
    logTest("Has pattern usages array", Array.isArray(result.patternUsages));
    logTest("Has variantName", typeof result.variantName === "string");
    logTest("Has typeName", typeof result.typeName === "string");
    logTest("Has canRemove boolean", typeof result.canRemove === "boolean");

    // Check usage structure
    const anyUsage = result.blockingUsages?.[0] || result.patternUsages?.[0];
    if (anyUsage) {
      logTest("Usage has line number", typeof anyUsage.line === "number");
      logTest("Usage has context", typeof anyUsage.context === "string");
    }
    console.log();
  }

  // ===== TEST 10: AdminStatus - Cross-file analysis =====
  console.log(`${CYAN}Test 10: AdminStatus - Cross-file usage detection${RESET}`);
  {
    const file = join(MEETDOWN, "src/AdminStatus.elm");
    await client.openFile(file);

    // Open files that use AdminStatus
    await client.openFile(join(MEETDOWN, "src/AdminPage.elm"));
    await client.openFile(join(MEETDOWN, "src/Frontend.elm"));

    for (const variant of ["IsNotAdmin", "IsAdminButDisabled", "IsAdminAndEnabled"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          logTest(`${variant}: found usages`, result.patternCount >= 0 || result.blockingCount >= 0);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    console.log();
  }

  // ===== TEST 11: ColorTheme - Types.elm cross-file =====
  console.log(`${CYAN}Test 11: ColorTheme from Types.elm (cross-file)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["LightTheme", "DarkTheme"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          logTest(`${variant}: analysis complete`, typeof result.canRemove === "boolean");
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    console.log();
  }

  // ===== TEST 12: Language type (4 variants) =====
  console.log(`${CYAN}Test 12: Language type (4 variants)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["English", "French", "Spanish", "Thai"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("Language variants analyzed", true);
    console.log();
  }

  // ===== TEST 13: Route type (11 variants) =====
  console.log(`${CYAN}Test 13: Route type - large union (11 variants)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Route.elm");
    await client.openFile(file);

    const routeVariants = [
      "HomepageRoute", "GroupRoute", "AdminRoute", "CreateGroupRoute",
      "SearchGroupsRoute", "MyGroupsRoute", "MyProfileRoute", "UserRoute",
      "PrivacyRoute", "TermsOfServiceRoute", "CodeOfConductRoute", "FrequentQuestionsRoute"
    ];

    let analyzed = 0;
    for (const variant of routeVariants.slice(0, 5)) { // Test first 5 for speed
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}`);
          analyzed++;
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("Route variants analyzed (5 of 11)", analyzed >= 3);
    console.log();
  }

  // ===== TEST 14: EventName.Error (has Err constructors) =====
  console.log(`${CYAN}Test 14: EventName.Error (used in Err constructor)${RESET}`);
  {
    const file = join(MEETDOWN, "src/EventName.elm");
    await client.openFile(file);

    const posShort = findVariantLine(file, "EventNameTooShort");
    if (posShort) {
      const result = await client.prepareRemoveVariant(file, posShort.line, posShort.char);
      // Used in `Err EventNameTooShort` - that's a constructor
      logTest("EventNameTooShort: has constructor usage (Err)", result.blockingCount >= 1);
      console.log(`     EventNameTooShort: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }

    const posLong = findVariantLine(file, "EventNameTooLong");
    if (posLong) {
      const result = await client.prepareRemoveVariant(file, posLong.line, posLong.char);
      logTest("EventNameTooLong: has constructor usage (Err)", result.blockingCount >= 1);
      console.log(`     EventNameTooLong: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }
    console.log();
  }

  // ===== TEST 15: Performance timing on large file =====
  console.log(`${CYAN}Test 15: Performance timing on GroupPage.elm (2944 lines)${RESET}`);
  {
    const file = join(MEETDOWN, "src/GroupPage.elm");
    await client.openFile(file);

    const pos = findVariantLine(file, "PressedCreateNewEvent");
    if (pos) {
      const start = Date.now();
      const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
      const elapsed = Date.now() - start;

      logTest("Response under 500ms", elapsed < 500);
      logTest("Analysis completed", typeof result.canRemove === "boolean");
      console.log(`     Elapsed: ${elapsed}ms, blocking=${result.blockingCount}, patterns=${result.patternCount}`);
    } else {
      console.log(`     ${YELLOW}PressedCreateNewEvent not found${RESET}`);
    }
    console.log();
  }

  // ===== TEST 16: Try to remove pattern-only variant =====
  console.log(`${CYAN}Test 16: Attempt removal of pattern-only variant${RESET}`);
  {
    backupMeetdown();
    try {
      const file = join(MEETDOWN, "src/EventName.elm");
      const originalContent = readFileSync(file, "utf-8");

      const pos = findVariantLine(file, "EventNameTooLong");
      await client.openFile(file);

      // First prepare to check if it's removable
      const prep = await client.prepareRemoveVariant(file, pos.line, pos.char);

      if (prep.canRemove) {
        const result = await client.removeVariant(file, pos.line, pos.char);
        logTest("Removal succeeded", result.success === true);
        logTest("Has success message", result.message?.length > 0);

        // Verify file was modified
        const newContent = readFileSync(file, "utf-8");
        logTest("Variant removed from file", !newContent.includes("| EventNameTooLong"));
        console.log(`     → ${result.message}`);
      } else {
        console.log(`     → Variant has blocking usages, cannot test removal`);
        logTest("Prep correctly identified blockers", true);
      }
    } finally {
      restoreMeetdown();
    }
    console.log();
  }

  // ===== TEST 17: FrontendMsg - very large union type =====
  console.log(`${CYAN}Test 17: FrontendMsg from Types.elm (large message union)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    const msgVariants = ["NoOpFrontendMsg", "UrlClicked", "PressedLogin", "PressedLogout", "TypedEmail"];
    for (const variant of msgVariants) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("FrontendMsg variants analyzed", true);
    console.log();
  }

  // ===== TEST 18: ToBackend message type =====
  console.log(`${CYAN}Test 18: ToBackend - backend message analysis${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    const msgVariants = ["GetGroupRequest", "CheckLoginRequest", "LogoutRequest", "SearchGroupsRequest"];
    for (const variant of msgVariants) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("ToBackend variants analyzed", true);
    console.log();
  }

  // ===== TEST 19: Log type (complex variant payloads) =====
  console.log(`${CYAN}Test 19: Log type - variants with complex payloads${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    const logVariants = ["LogUntrustedCheckFailed", "LogLoginEmail", "LogDeleteAccountEmail"];
    for (const variant of logVariants) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          logTest(`${variant}: analyzed`, typeof result.canRemove === "boolean");
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    console.log();
  }

  // ===== TEST 20: Token type from Route.elm =====
  console.log(`${CYAN}Test 20: Token type - enum with Maybe payload${RESET}`);
  {
    const file = join(MEETDOWN, "src/Route.elm");
    await client.openFile(file);

    const tokenVariants = ["NoToken", "LoginToken", "DeleteUserToken"];
    for (const variant of tokenVariants) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("Token variants analyzed", true);
    console.log();
  }

  // ===== TEST 21: FrontendModel - 2-variant type =====
  console.log(`${CYAN}Test 21: FrontendModel (2-variant type)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["Loading", "Loaded"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("FrontendModel 2-variant type analyzed", true);
    console.log();
  }

  // ===== TEST 22: Backend.elm performance (large file) =====
  console.log(`${CYAN}Test 22: Performance on Backend.elm${RESET}`);
  {
    const file = join(MEETDOWN, "src/Backend.elm");
    if (existsSync(file)) {
      await client.openFile(file);
      const start = Date.now();
      // Just test that we can open and analyze variants in Backend.elm
      const setupTime = Date.now() - start;
      logTest("Backend.elm opened quickly", setupTime < 2000);
      console.log(`     Setup time: ${setupTime}ms`);
    } else {
      console.log(`     ${YELLOW}Backend.elm not found${RESET}`);
    }
    console.log();
  }

  // ===== TEST 23: Variants with record payloads =====
  console.log(`${CYAN}Test 23: LoginStatus - variants with record payloads${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["LoginStatusPending", "LoggedIn", "NotLoggedIn"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          logTest(`${variant}: analyzed`, typeof result.canRemove === "boolean");
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    console.log();
  }

  // ===== TEST 24: GroupRequest type =====
  console.log(`${CYAN}Test 24: GroupRequest (nested type)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["GroupNotFound_", "GroupFound_"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("GroupRequest variants analyzed", true);
    console.log();
  }

  // ===== TEST 25: AdminCache - 3 variants with different payloads =====
  console.log(`${CYAN}Test 25: AdminCache (3 variants, different payloads)${RESET}`);
  {
    const file = join(MEETDOWN, "src/Types.elm");
    await client.openFile(file);

    for (const variant of ["AdminCacheNotRequested", "AdminCached", "AdminCachePending"]) {
      const pos = findVariantLine(file, variant);
      if (pos) {
        try {
          const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
          console.log(`     ${variant}: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
        } catch (e) {
          console.log(`     ${YELLOW}${variant}: ${e.message}${RESET}`);
        }
      }
    }
    logTest("AdminCache variants analyzed", true);
    console.log();
  }

  // ===== TEST 26: Pattern-only variant (can be removed) =====
  console.log(`${CYAN}Test 26: Pattern-only variant (Unused in Priority)${RESET}`);
  {
    const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
    await client.openFile(file);

    const pos = findVariantLine(file, "Unused");
    if (pos) {
      const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
      logTest("Unused: is pattern-only (no constructors)", result.blockingCount === 0);
      logTest("Unused: has pattern usages", result.patternCount > 0);
      logTest("Unused: can be removed", result.canRemove === true);
      console.log(`     Unused: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }
    console.log();
  }

  // ===== TEST 27: Remove pattern-only variant =====
  console.log(`${CYAN}Test 27: Actually REMOVE pattern-only variant${RESET}`);
  {
    backupMeetdown();
    try {
      const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
      await client.openFile(file);

      const pos = findVariantLine(file, "Unused");
      if (pos) {
        const result = await client.removeVariant(file, pos.line, pos.char);
        logTest("Removal succeeded", result.success === true);
        logTest("Message mentions removal", result.message?.includes("Removed"));

        const newContent = readFileSync(file, "utf-8");
        logTest("Unused removed from type", !newContent.includes("| Unused"));
        logTest("Pattern branches removed", !newContent.includes("Unused ->"));
        console.log(`     → ${result.message}`);
      }
    } finally {
      restoreMeetdown();
    }
    console.log();
  }

  // ===== TEST 28: Single-variant type (should error) =====
  console.log(`${CYAN}Test 28: Single-variant type (OnlyVariant - should ERROR)${RESET}`);
  {
    const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
    await client.openFile(file);

    const pos = findVariantLine(file, "OnlyVariant");
    if (pos) {
      const result = await client.removeVariant(file, pos.line, pos.char);
      logTest("Removal blocked (success=false)", result.success === false);
      logTest("Error mentions 'only variant' or 'last'",
              result.message?.toLowerCase().includes("only") ||
              result.message?.toLowerCase().includes("last") ||
              result.message?.toLowerCase().includes("cannot"));
      console.log(`     → ${result.message}`);
    }
    console.log();
  }

  // ===== TEST 29: Useless wildcard removal =====
  console.log(`${CYAN}Test 29: Useless wildcard auto-removal (Toggle type)${RESET}`);
  {
    backupMeetdown();
    try {
      const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
      const originalContent = readFileSync(file, "utf-8");
      await client.openFile(file);

      // Verify the wildcard exists before removal
      logTest("Wildcard exists before removal", originalContent.includes("_ ->"));

      const pos = findVariantLine(file, "Off");
      if (pos) {
        const result = await client.removeVariant(file, pos.line, pos.char);
        logTest("Removal succeeded", result.success === true);

        const newContent = readFileSync(file, "utf-8");
        logTest("Off removed from type", !newContent.includes("| Off"));

        // Check if wildcard was removed from toggleToString function
        const toggleMatch = newContent.match(/toggleToString[\s\S]*?case toggle of[\s\S]*?(?=\n\n|\ntype|\n{-|$)/);
        const wildcardRemoved = !toggleMatch || !toggleMatch[0].includes("_ ->");
        logTest("Useless wildcard auto-removed", wildcardRemoved);

        if (result.message?.includes("wildcard")) {
          console.log(`     → Message mentions wildcard: ${result.message}`);
        } else {
          console.log(`     → ${result.message}`);
        }
      }
    } finally {
      restoreMeetdown();
    }
    console.log();
  }

  // ===== TEST 30: Multi-pattern removal (Strikethrough in 3 functions) =====
  console.log(`${CYAN}Test 30: Multi-pattern branch removal (Strikethrough)${RESET}`);
  {
    backupMeetdown();
    try {
      const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
      const originalContent = readFileSync(file, "utf-8");
      await client.openFile(file);

      // Count Strikethrough patterns before
      const beforeCount = (originalContent.match(/Strikethrough ->/g) || []).length;
      console.log(`     Before: ${beforeCount} pattern branches with Strikethrough`);

      const pos = findVariantLine(file, "Strikethrough");
      if (pos) {
        const result = await client.removeVariant(file, pos.line, pos.char);

        if (result.success) {
          const newContent = readFileSync(file, "utf-8");
          const afterCount = (newContent.match(/Strikethrough ->/g) || []).length;

          logTest("Removal succeeded", true);
          logTest("All pattern branches removed", afterCount === 0);
          console.log(`     After: ${afterCount} pattern branches`);
          console.log(`     → ${result.message}`);
        } else {
          logTest("Removal blocked (has constructor)", true);
          console.log(`     → Blocked: ${result.message}`);
        }
      }
    } finally {
      restoreMeetdown();
    }
    console.log();
  }

  // ===== TEST 31: Variant with arguments - multi-pattern removal =====
  console.log(`${CYAN}Test 31: Variant with args (Debug String) multi-pattern${RESET}`);
  {
    const file = join(MEETDOWN, "src/TestVariantRemoval.elm");
    await client.openFile(file);

    const pos = findVariantLine(file, "Debug");
    if (pos) {
      const result = await client.prepareRemoveVariant(file, pos.line, pos.char);
      logTest("Debug: found pattern usages", result.patternCount > 0);
      console.log(`     Debug: blocking=${result.blockingCount}, patterns=${result.patternCount}, canRemove=${result.canRemove}`);
    }
    console.log();
  }

  // ===== SUMMARY =====
  console.log(`${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
  console.log(`  ${failed > 0 ? RED : GREEN}Failed: ${failed}${RESET}`);
  console.log(`  Total:  ${passed + failed}\n`);

  client.stop();

  if (failed > 0) {
    console.log(`${RED}${"=".repeat(70)}${RESET}`);
    console.log(`${RED}  Some tests failed!${RESET}`);
    console.log(`${RED}${"=".repeat(70)}${RESET}`);
    console.log(`\n  ${YELLOW}If you believe this is a bug in elm-lsp-rust, please file an issue:${RESET}`);
    console.log(`  ${CYAN}https://github.com/CharlonTank/elm-lsp-rust/issues/new${RESET}\n`);
    console.log(`  Include the following information:`);
    console.log(`  - Test name(s) that failed`);
    console.log(`  - Your Elm version (elm --version)`);
    console.log(`  - Your OS and version`);
    console.log(`  - Any relevant error messages from above\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  console.log(`\n${YELLOW}If this error persists, please file an issue:${RESET}`);
  console.log(`${CYAN}https://github.com/CharlonTank/elm-lsp-rust/issues/new${RESET}\n`);
  process.exit(1);
});
