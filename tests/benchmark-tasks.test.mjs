/**
 * Tests of benchmarks/lib/tasks.mjs, which picks the targets of the refactoring
 * tasks and judges what a session left behind. Each test builds the sources and
 * patches it judges, and some write them to a temporary directory. They start
 * no process and read no clock. The one test that has git make its patch is in
 * tests/benchmark.test.mjs.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { compiledFiles, scanOutsiders, scanProject, scanSource } from "../benchmarks/lib/elm-source.mjs";
import { heldBack, rankedTargets, TASK_TYPES, unmetExpectations, usedOutside } from "../benchmarks/lib/tasks.mjs";
import { tempDir } from "./support.mjs";
import { left, SHAPES } from "./benchmark-support.mjs";

const taskType = (id) => TASK_TYPES.find((type) => type.id === id);

// Scanned modules from { "File.elm": source } pairs.
const project = (sources) => Object.entries(sources).map(([file, text]) => scanSource(file, text));

// What a check command that names `entries` compiles of the modules
const builtFrom = (modules, entries) => ({ entries, compiled: compiledFiles(modules, entries) });

// As if the check command compiled every module
const allBuilt = (modules) => ({ entries: [], compiled: new Set(modules.map((source) => source.file)) });

// `count` modules that import Lib and call Lib.<name>.
const callers = (name, count) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const module = `${name[0].toUpperCase()}${name.slice(1)}User${i}`;
      return [`src/${module}.elm`, `module ${module} exposing (x)\n\nimport Lib\n\n\nx =\n    Lib.${name}\n`];
    })
  );

test("the target nearest to the ideal size is picked, and small ones are left out", () => {
  const modules = project({
    "src/Lib.elm": "module Lib exposing (..)\n\n\nfarOff : Int\nfarOff =\n    1\n\n\nnearby : Int\nnearby =\n    2\n\n\nlonely : Int\nlonely =\n    3\n",
    ...callers("farOff", 3),
    ...callers("nearby", 8),
    ...callers("lonely", 1),
  });

  const ranked = rankedTargets(taskType("rename-function"), modules, allBuilt(modules), 2);
  assert.deepEqual(
    ranked.map((target) => [target.name, target.size]),
    [
      ["nearby", 8],
      ["farOff", 3],
    ]
  );
  // Every module that imports Lib may change, whether it uses the function or not
  assert.equal(ranked[0].mayChange.length, 1 + 12);

  // A function that its module keeps to itself involves no other file, whatever an importer calls its own things
  const kept = project({
    "src/Lib.elm": "module Lib exposing (shown)\n\n\nshown : Int\nshown =\n    hidden\n\n\nhidden : Int\nhidden =\n    1\n",
    "src/Uses.elm": "module Uses exposing (x)\n\nimport Lib exposing (..)\n\n\nx : Int\nx =\n    let\n        hidden =\n            2\n    in\n    hidden + shown\n",
  });
  const sizes = taskType("rename-function").candidates(kept).map((candidate) => [candidate.key, candidate.size]);
  assert.deepEqual(sizes, [["src/Lib.elm:shown", 1], ["src/Lib.elm:hidden", 0]]);
  // A name in an import that goes on over several lines is no use of it
  const listed = project({
    "src/Lib.elm": "module Lib exposing (shown)\n\n\nshown : Int\nshown =\n    1\n",
    "src/Lists.elm": "module Lists exposing (x)\n\nimport\n    Lib\n    exposing\n        ( shown\n        )\n\n\nx : Int\nx =\n    1\n",
    "src/Uses.elm": "module Uses exposing (x)\n\nimport\n    Lib\n    exposing\n        ( shown\n        )\n\n\nx : Int\nx =\n    shown\n",
  });
  assert.deepEqual(taskType("rename-function").candidates(listed).map((candidate) => candidate.size), [1]);
});

test("a shared-name target needs the name in at least three other modules", () => {
  const declaring = (module) => `module ${module} exposing (view)\n\n\nview : Int\nview =\n    1\n`;
  const sources = {
    "src/Page.elm": declaring("Page"),
    "src/Main.elm": "module Main exposing (main)\n\nimport Page\n\n\nmain =\n    Page.view\n",
    "src/A.elm": declaring("A"),
    "src/B.elm": declaring("B"),
  };
  const shared = taskType("rename-shared-function");
  const three = project(sources);
  assert.deepEqual(rankedTargets(shared, three, allBuilt(three), 1), []);

  const four = project({ ...sources, "src/C.elm": declaring("C") });
  const [target] = rankedTargets(shared, four, allBuilt(four), 1);
  assert.equal(target.key, "src/Page.elm:view");
  assert.deepEqual(target.namesakes, ["src/A.elm", "src/B.elm", "src/C.elm"]);
  assert.match(
    shared.build(target, "elm make src/Main.elm").prompt,
    /in the project\. 3 other modules declare a `view` of their own\. Those are different functions and keep their name\.\n\nChange nothing else\./
  );
  // The unique-name task never takes such a function
  assert.deepEqual(rankedTargets(taskType("rename-function"), four, allBuilt(four), 1), []);
});

test("test modules are scanned, and a target they use is left out unless they are compiled", (t) => {
  const elmRoot = tempDir(t);
  const write = (file, text) => {
    mkdirSync(join(elmRoot, file, ".."), { recursive: true });
    writeFileSync(join(elmRoot, file), text);
  };
  write("elm.json", JSON.stringify({ "source-directories": ["src"] }));
  write("src/Lib.elm", "module Lib exposing (double)\n\n\ndouble : Int -> Int\ndouble n =\n    n * 2\n");
  write("src/Main.elm", "module Main exposing (main)\n\nimport Lib\n\n\nmain =\n    Lib.double 1\n");
  write("tests/LibTest.elm", "module LibTest exposing (suite)\n\nimport Lib\n\n\nsuite =\n    Lib.double 2\n");
  write("elm-stuff/generated/Skipped.elm", "module Skipped exposing (x)\n\nimport Lib\n");

  const modules = scanProject(elmRoot);
  assert.deepEqual(modules.map((source) => source.file), ["src/Lib.elm", "src/Main.elm", "tests/LibTest.elm"]);

  // The compiler never reads the test module, so it would not notice a use of the old name left in it
  const renames = (entries) => rankedTargets(taskType("rename-function"), modules, builtFrom(modules, entries), 1);
  assert.deepEqual(renames(["src/Main.elm"]), []);

  // When the check command builds the test module too, the rename may edit it
  const [target] = renames(["src/Main.elm", "tests/LibTest.elm"]);
  assert.equal(target.name, "double");
  assert.deepEqual(target.mayChange, ["src/Lib.elm", "src/Main.elm", "tests/LibTest.elm"]);

  // A package lists no source directories. Its modules are in src.
  write("elm.json", JSON.stringify({ type: "package" }));
  assert.deepEqual(scanProject(elmRoot).map((source) => source.file), ["src/Lib.elm", "src/Main.elm", "tests/LibTest.elm"]);

  // A source directory inside another one, the project's root as one, and a directory under two spellings: every
  // file is read once. Read twice, a file is two modules, and each variant in it has a namesake.
  write("src/vendor/Palette.elm", "module Palette exposing (Color(..))\n\n\ntype Color\n    = Crimson\n    | Green\n    | Blue\n");
  for (const directories of [["src", "src/vendor"], ["src/vendor", "src"], [".", "src"], ["src", "./tests", "tests/", "src/"]]) {
    write("elm.json", JSON.stringify({ "source-directories": directories }));
    const read = scanProject(elmRoot);
    assert.deepEqual(read.map((source) => source.file), ["src/Lib.elm", "src/Main.elm", "src/vendor/Palette.elm", "tests/LibTest.elm"]);
    const variants = taskType("rename-variant").candidates(read);
    assert.deepEqual(variants.map((candidate) => [candidate.variant, candidate.namesakes]), [["Crimson", []], ["Green", []], ["Blue", []]]);
  }
});

test("an Elm file outside the project is found, and so is a target it can use", (t) => {
  const elmRoot = tempDir(t);
  const write = (file, text) => {
    mkdirSync(join(elmRoot, file, ".."), { recursive: true });
    writeFileSync(join(elmRoot, file), text);
  };
  write("elm.json", JSON.stringify({ "source-directories": ["src"] }));
  write("src/Lib.elm", "module Lib exposing (double)\n\n\ndouble : Int -> Int\ndouble n =\n    n * 2\n");
  write("src/Other.elm", "module Other exposing (triple)\n\n\ntriple : Int -> Int\ntriple n =\n    n * 3\n");
  write("src/Main.elm", "module Main exposing (main)\n\nimport Lib\nimport Other\n\n\nmain =\n    Lib.double (Other.triple 1)\n");
  // An example with an elm.json of its own, which reaches the library through "../src"
  write("examples/elm.json", JSON.stringify({ "source-directories": ["src", "../src"] }));
  write("examples/src/Demo.elm", "module Demo exposing (demo)\n\nimport Lib\n\n\ndemo =\n    Lib.double 2\n");
  // The lock an editor keeps beside a file with unsaved changes leads nowhere
  symlinkSync("someone@host.1234", join(elmRoot, "src/.#Main.elm"));
  // And two links that lead around in a circle: to the directory itself, and to the one above
  symlinkSync(".", join(elmRoot, "src/again"));
  symlinkSync("..", join(elmRoot, "examples/all"));

  const modules = scanProject(elmRoot);
  assert.deepEqual(modules.map((source) => source.file), ["src/Lib.elm", "src/Main.elm", "src/Other.elm"]);
  const outsiders = scanOutsiders(elmRoot, modules);
  assert.deepEqual(outsiders.map((source) => source.file), ["examples/src/Demo.elm"]);

  // No check compiles the example. A rename that passed it over would pass, and one that followed it there would not.
  const targets = rankedTargets(taskType("rename-function"), modules, allBuilt(modules), 1);
  assert.deepEqual(
    targets.map((target) => [target.name, usedOutside(target, outsiders)]),
    [["double", true], ["triple", false]]
  );
  // A field can be read without an import of its record
  assert.equal(usedOutside({ module: "Elsewhere", field: "demo" }, outsiders), true);
  assert.equal(usedOutside({ module: "Elsewhere", field: "label" }, outsiders), false);
});

test("the check command must compile the target and every module the change can break", () => {
  const modules = project({
    "src/Main.elm": "module Main exposing (main)\n\nimport Used\n\n\nmain =\n    Used.value\n",
    "src/Used.elm": "module Used exposing (value)\n\nimport Deep\n\n\nvalue : Int\nvalue =\n    Deep.depth + Deep.width\n",
    "src/Deep.elm": "module Deep exposing (depth, width)\n\n\ndepth : Int\ndepth =\n    1\n\n\nwidth : Int\nwidth =\n    2\n",
    // Never reached from Main, so the compiler would not notice if a rename broke them
    "src/Orphan.elm": "module Orphan exposing (stray)\n\n\nstray : Int\nstray =\n    1\n",
    "src/OrphanUser.elm": "module OrphanUser exposing (x)\n\nimport Orphan\n\n\nx =\n    Orphan.stray\n",
  });
  const names = (built) => rankedTargets(taskType("rename-function"), modules, built, 1).map((target) => target.name);

  assert.deepEqual(names(allBuilt(modules)), ["depth", "width", "stray", "value"]);
  assert.deepEqual(names(builtFrom(modules, ["src/Main.elm"])), ["depth", "width", "value"]);

  // One module outside the build that imports Deep takes Deep's functions out
  const withOutsider = project({
    ...Object.fromEntries(modules.map((source) => [source.file, source.text])),
    "src/Outsider.elm": "module Outsider exposing (y)\n\nimport Deep\n\n\ny =\n    Deep.depth\n",
  });
  assert.deepEqual(
    rankedTargets(taskType("rename-function"), withOutsider, builtFrom(withOutsider, ["src/Main.elm"]), 1).map((target) => target.name),
    ["value"]
  );
  // A plan without a target names the file that holds back the most candidates, here both functions of
  // Deep, and counts the files that hold back any: the two orphans as well
  assert.deepEqual(heldBack(taskType("rename-function"), withOutsider, builtFrom(withOutsider, ["src/Main.elm"]), 1), {
    file: "src/Outsider.elm",
    candidates: 2,
    files: 3,
  });
  assert.equal(heldBack(taskType("rename-function"), modules, allBuilt(modules), 1), null);
});

test("a field can be read without importing its record, so every module that names it must be compiled", () => {
  const record = (module) => `module ${module} exposing (${module}Record)\n\n\ntype alias ${module}Record =\n    { title : String\n    }\n`;
  const modules = project({
    "src/Main.elm": "module Main exposing (main)\n\nimport A\nimport B\nimport C\nimport Reader\n\n\nmain : A.ARecord -> String\nmain a =\n    Reader.show a\n",
    "src/A.elm": record("A"),
    "src/B.elm": record("B"),
    "src/C.elm": record("C"),
    "src/Reader.elm": "module Reader exposing (show)\n\nimport A exposing (ARecord)\n\n\nshow : ARecord -> String\nshow a =\n    a.title\n",
    // Imports none of the records and still depends on the field's name
    "src/Loose.elm": "module Loose exposing (heading)\n\n\nheading thing =\n    thing.title\n",
  });
  const fields = (built) => rankedTargets(taskType("rename-field"), modules, built, 1).map((target) => target.key);

  assert.deepEqual(fields(allBuilt(modules)), ["src/A.elm:ARecord.title"]);
  assert.deepEqual(fields(builtFrom(modules, ["src/Main.elm"])), []);
  // A name of three letters is too often the name of something else in the same files
  const short = project(Object.fromEntries(modules.map((source) => [source.file, source.text.replaceAll("title", "tag")])));
  assert.deepEqual(rankedTargets(taskType("rename-field"), short, allBuilt(short), 1), []);

  // A function that takes every record with the field ties the records together: none can rename it alone
  const tied = project({
    ...Object.fromEntries(modules.map((source) => [source.file, source.text])),
    "src/Any.elm": "module Any exposing (heading)\n\n\nheading : { a | title : String } -> String\nheading thing =\n    thing.title\n",
  });
  assert.deepEqual(rankedTargets(taskType("rename-field"), tied, allBuilt(tied), 1), []);
});

test("a variant's users are the modules that can name it, and its namesakes are told apart", () => {
  const modules = project({
    "src/Status.elm": "module Status exposing (Status(..))\n\n\ntype Status\n    = Active\n    | Idle\n",
    "src/Bare.elm": "module Bare exposing (x)\n\nimport Status exposing (Status(..))\n\n\nx =\n    Active\n",
    "src/Qualified.elm": "module Qualified exposing (x)\n\nimport Status as S\n\n\nx =\n    S.Active\n",
    // Imports the type alone, and the Active it uses is its own
    "src/Other.elm":
      "module Other exposing (Mode(..), x)\n\nimport Status exposing (Status)\n\n\ntype Mode\n    = Active\n    | Off\n\n\nx : Status -> Mode\nx _ =\n    Active\n",
    // Only says the word
    "src/Talks.elm": 'module Talks exposing (x)\n\nimport Status\n\n\nx =\n    "Active" -- Active\n',
  });
  const target = rankedTargets(taskType("rename-variant"), modules, allBuilt(modules), 1).find(
    (candidate) => candidate.key === "src/Status.elm:Status.Active"
  );
  assert.equal(target.size, 2);
  assert.deepEqual(target.namesakes, [{ file: "src/Other.elm", type: "Mode" }]);

  const { prompt, expect } = taskType("rename-variant").build(target, "elm make src/Main.elm");
  assert.match(prompt, /1 other custom type has a variant called `Active` too\. It keeps that name there\./);
  assert.deepEqual(expect[2], { kind: "variants-kept", variant: "Active", types: [{ file: "src/Other.elm", type: "Mode" }] });

  // A variant that its module keeps to itself involves no other file, whoever names its type. And
  // one that is called like its type is no target: a use of the type reads like a use of the variant.
  const mail = project({
    "src/Mail.elm": 'module Mail exposing (Address, Folder(..), inbox)\n\n\ntype Address\n    = Hidden String\n\n\ntype Folder\n    = Folder String\n\n\ninbox : Folder\ninbox =\n    Folder "in"\n',
    "src/Uses.elm": 'module Uses exposing (x)\n\nimport Mail exposing (Address, Folder(..))\n\n\nx : Address -> Folder\nx _ =\n    Folder "x"\n',
  });
  const sizes = taskType("rename-variant").candidates(mail).map((candidate) => [candidate.key, candidate.size]);
  assert.deepEqual(sizes, [["src/Mail.elm:Address.Hidden", 0]]);

  // A type of the variant's name is no way to the variant: an import that exposes it takes no variant along
  const route = project({
    "src/Route.elm": "module Route exposing (Profile, Route(..))\n\n\ntype Route\n    = Home\n    | Profile Profile\n\n\ntype alias Profile =\n    { name : String }\n",
    "src/Page.elm": "module Page exposing (x)\n\nimport Route exposing (Profile)\n\n\nx : Profile -> String\nx profile =\n    profile.name\n",
    "src/Goes.elm": "module Goes exposing (x)\n\nimport Route exposing (Route(..))\n\n\nx : Route\nx =\n    Profile { name = \"\" }\n",
  });
  const routes = taskType("rename-variant").candidates(route).map((candidate) => [candidate.key, candidate.size]);
  assert.deepEqual(routes, [["src/Route.elm:Route.Home", 0], ["src/Route.elm:Route.Profile", 1]]);
  // And neither is the import of a module that is called like the variant behind its module's name
  const nested = project({
    "src/Shape.elm": "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Kind\n    | Round\n",
    "src/Shape/Kind.elm": "module Shape.Kind exposing (one)\n\n\none : Int\none =\n    1\n",
    "src/Uses.elm": "module Uses exposing (two)\n\nimport Shape\nimport Shape.Kind as Kinds\n\n\ntwo : Int\ntwo =\n    Kinds.one\n",
  });
  assert.deepEqual(taskType("rename-variant").candidates(nested).map((candidate) => [candidate.variant, candidate.size]), [["Kind", 0], ["Round", 0]]);

  // A type that keeps its variants to its module gets a new one in that module alone, whatever an importer
  // calls the variants of a type of its own
  const light = ["type Light", "    = Red", "    | Amber", "    | Green"];
  const next = ["next : Light -> Light", "next light =", "    case light of", "        Red ->", "            Green", "", "        Amber ->", "            Red", "", "        Green ->", "            Amber"];
  const paint = ["type Paint", "    = Red", "    | Blue", "", "", "name : Paint -> String", "name paint =", "    case paint of", "        Red ->", '            "red"', "", "        Blue ->", '            "blue"'];
  const lights = (exposing) =>
    taskType("add-variant")
      .candidates(
        project({
          "src/Light.elm": [`module Light exposing (${exposing}, next)`, "", "", ...light, "", "", ...next, ""].join("\n"),
          "src/Paint.elm": ["module Paint exposing (name)", "", "import Light exposing (..)", "", "", ...paint, ""].join("\n"),
        })
      )
      .map((candidate) => [candidate.key, candidate.size]);
  assert.deepEqual([lights("Light"), lights("Light(..)")], [[["src/Light.elm:Light", 1]], [["src/Light.elm:Light", 2]]]);
});

test("a target named in letters outside ASCII is found and judged by its whole name", (t) => {
  const café = [
    "module Café exposing (État(..), libellé)",
    "",
    "",
    "type État",
    "    = Ouverte",
    "    | Fermée",
    "    | Complète",
    "",
    "",
    "libellé : État -> String",
    "libellé état =",
    "    case état of",
    "        Ouverte ->",
    '            "ouverte"',
    "",
    "        Fermée ->",
    '            "fermée"',
    "",
    "        Complète ->",
    '            "complète"',
    "",
  ].join("\n");
  const sources = {
    "src/Café.elm": café,
    "src/Bare.elm": "module Bare exposing (x)\n\nimport Café exposing (État(..))\n\n\nx =\n    Fermée\n",
    "src/Qualified.elm": "module Qualified exposing (x)\n\nimport Café as Bistro\n\n\nx =\n    Bistro.libellé Bistro.Fermée\n",
    // Imports the module and only says the words. Fermées is another name.
    "src/Talks.elm": 'module Talks exposing (x)\n\nimport Café exposing (..)\n\n\nx =\n    "Fermée libellé" -- Fermée, libellé\n\n\ntype Fermées\n    = Fermées\n',
  };
  const modules = project(sources);
  const target = (id, key) => rankedTargets(taskType(id), modules, allBuilt(modules), 1).find((candidate) => candidate.key === key);
  assert.equal(target("rename-variant", "src/Café.elm:État.Fermée").size, 2);
  assert.equal(target("rename-function", "src/Café.elm:libellé").size, 1);
  assert.equal(target("rename-module", "src/Café.elm").size, 3);
  // The one file with a branch on a variant of the type
  assert.equal(target("add-variant", "src/Café.elm:État").size, 1);

  // A rename of the variant to the name the task asks for, in every file that names it
  const elmRoot = tempDir(t);
  mkdirSync(join(elmRoot, "src"));
  const renamed = (text) => text.replaceAll(/(?<![\p{L}\d_"])Fermée(?![\p{L}\d_])/gu, "FerméeRenamed");
  const changed = ["src/Bare.elm", "src/Café.elm", "src/Qualified.elm"];
  for (const [file, text] of Object.entries(sources)) writeFileSync(join(elmRoot, file), changed.includes(file) ? renamed(text) : text);
  const { expect } = taskType("rename-variant").build(target("rename-variant", "src/Café.elm:État.Fermée"), "elm make src/Main.elm");
  assert.deepEqual(expect[0], { kind: "type-has-variant", file: "src/Café.elm", type: "État", variant: "FerméeRenamed" });
  const judged = (after = {}) => {
    for (const [file, text] of Object.entries(after)) writeFileSync(join(elmRoot, file), text);
    return unmetExpectations(elmRoot, expect, left({ changed, originals: new Map(changed.map((file) => [file, sources[file]])), committed: new Set(Object.keys(sources)) }));
  };
  assert.deepEqual(judged(), []);
  // The same rename with the string changed too is more than the name
  assert.deepEqual(judged({ "src/Café.elm": renamed(café).replace('"fermée"', '"closed"') }), ['src/Café.elm changed in more than the name: "fermée" became "closed"']);
});

test("the module that the check command builds is never renamed", () => {
  const modules = project({
    "src/Main.elm": "module Main exposing (main)\n\nimport Lib\n\n\nmain =\n    Lib.x\n",
    "src/Lib.elm": "module Lib exposing (x)\n\nimport Main\n\n\nx =\n    1\n",
  });
  const targets = rankedTargets(taskType("rename-module"), modules, builtFrom(modules, ["src/Main.elm"]), 1);
  assert.deepEqual(targets.map((target) => target.file), ["src/Lib.elm"]);

  // The name changes where it names the module. A package names it in elm.json as well, and there only.
  const { expect } = taskType("rename-module").build(targets[0], "elm make src/Main.elm");
  assert.deepEqual(expect.slice(3), [
    { kind: "renames-only", of: "module", from: "Lib", to: "LibRenamed", moved: ["src/Lib.elm", "src/LibRenamed.elm"] },
    { kind: "changes-only-in", files: ["src/Lib.elm", "src/LibRenamed.elm", "src/Main.elm"] },
    { kind: "only-elm-files", except: ["elm.json"] },
    { kind: "elm-json-renames-only", from: "Lib", to: "LibRenamed" },
  ]);
  // The request names elm.json where the package exposes the module, and nowhere else
  const request = (exposed) => taskType("rename-module").build(targets[0], "elm make src/Main.elm", { exposed }).prompt;
  assert.match(request(["Lib"]), /qualified reference to it\. The package exposes the module, so change its name in the `exposed-modules` of `elm\.json` as well\.\n\nChange nothing else\./);
  assert.match(request(["Other"]), /qualified reference to it\.\n\nChange nothing else\./);
});

test("what shares the target's name and is another kind of thing has to keep it", () => {
  const modules = project({
    "src/Page.elm":
      'module Page exposing (..)\n\nimport Settings\n\n\ntype Page\n    = Settings Settings.Model\n    | Home\n\n\ntype alias Config =\n    { view : Int\n    , title : String\n    }\n\n\nview : Int\nview =\n    1\n\n\ntitle : String\ntitle =\n    ""\n',
    "src/Settings.elm": "module Settings exposing (..)\n\n\ntype alias Settings =\n    Int\n\n\ntype alias Model =\n    { title : String }\n",
    "src/Other.elm": "module Other exposing (..)\n\n\ntype alias Other =\n    { title : String }\n",
    "src/Main.elm": "module Main exposing (main)\n\nimport Page\n\n\nmain =\n    ( Page.view, Page.Settings, .title )\n",
  });
  const expected = (id, key, kind) => {
    const target = rankedTargets(taskType(id), modules, allBuilt(modules), 0).find((candidate) => candidate.key === key);
    return taskType(id).build(target, "elm make src/Main.elm").expect.find((expectation) => expectation.kind === kind);
  };

  // A text replace would rename each of these along, and the project would still compile
  assert.deepEqual(expected("rename-function", "src/Page.elm:view", "fields-kept"), {
    kind: "fields-kept",
    field: "view",
    aliases: [{ file: "src/Page.elm", alias: "Config" }],
  });
  assert.deepEqual(expected("rename-variant", "src/Page.elm:Page.Settings", "types-kept"), { kind: "types-kept", name: "Settings", files: ["src/Settings.elm"] });
  assert.deepEqual(expected("rename-field", "src/Page.elm:Config.title", "functions-kept"), { kind: "functions-kept", name: "title", files: ["src/Page.elm"] });
  // Where nothing shares the name, nothing is asked
  assert.equal(expected("rename-variant", "src/Page.elm:Page.Home", "types-kept"), undefined);
});

test("expectations are checked against the files the agent left behind", (t) => {
  const elmRoot = tempDir(t);
  mkdirSync(join(elmRoot, "src"));
  writeFileSync(join(elmRoot, "elm.json"), JSON.stringify({ "source-directories": ["src"] }));
  writeFileSync(join(elmRoot, "src/Shapes.elm"), SHAPES);
  writeFileSync(join(elmRoot, "src/Main.elm"), 'module Main exposing (main)\n\nimport Shapes\n\n\nmain =\n    Debug.todo "later"\n');
  const file = "src/Shapes.elm";

  const met = [
    { kind: "declares-function", file, name: "area" },
    { kind: "lacks-function", file, name: "perimeter" },
    { kind: "functions-kept", name: "area", files: [file] },
    { kind: "type-has-variant", file, type: "Shape", variant: "Polygon" },
    { kind: "type-has-variant", file, type: "Shape", variant: "Dot", last: true },
    { kind: "type-lacks-variant", file, type: "Shape", variant: "Square" },
    { kind: "variants-kept", variant: "Dot", types: [{ file, type: "Shape" }] },
    { kind: "types-kept", name: "Id", files: [file] },
    { kind: "alias-has-field", file, alias: "Point", field: "label" },
    { kind: "alias-lacks-field", file, alias: "Point", field: "size" },
    { kind: "fields-kept", field: "x", aliases: [{ file, alias: "Point" }] },
    { kind: "file-missing", file: "src/Old.elm" },
    { kind: "declares-module", file, module: "Shapes" },
    { kind: "no-import-of", module: "Shape" },
    { kind: "changes-only-in", files: [file] },
    { kind: "only-elm-files", except: ["elm.json"] },
  ];
  // The commit holds the two sources and elm.json, and beside the Elm project a README and the source of
  // another program. The page that a plain "elm make" writes is no change to them, and neither is a note.
  const committed = new Set([file, "src/Main.elm", "elm.json", "data/prices.json", "build.sh", "../README.md", "../admin/src/Admin.elm"]);
  assert.deepEqual(unmetExpectations(elmRoot, met, left({ changed: [file, "elm.json", "index.html", "../notes.txt"], committed })), []);

  const unmet = [
    { kind: "declares-function", file, name: "perimeter" },
    { kind: "lacks-function", file, name: "area" },
    { kind: "functions-kept", name: "area", files: ["src/Main.elm"] },
    { kind: "type-has-variant", file, type: "Shape", variant: "Square" },
    { kind: "type-has-variant", file, type: "Shape", variant: "Polygon", last: true },
    { kind: "type-lacks-variant", file, type: "Shape", variant: "Dot" },
    { kind: "variants-kept", variant: "Square", types: [{ file, type: "Shape" }] },
    { kind: "types-kept", name: "Dot", files: [file, "src/Gone.elm"] },
    { kind: "alias-has-field", file, alias: "Point", field: "size" },
    { kind: "alias-lacks-field", file, alias: "Point", field: "label" },
    { kind: "fields-kept", field: "z", aliases: [{ file, alias: "Point" }] },
    { kind: "file-missing", file },
    { kind: "declares-module", file: "src/Gone.elm", module: "Gone" },
    { kind: "no-import-of", module: "Shapes" },
    { kind: "changes-only-in", files: [file] },
    { kind: "only-elm-files", except: ["elm.json"] },
  ];
  const changed = [file, "src/Main.elm", "elm.json", "data/prices.json", "build.sh", "index.html", "../README.md", "../admin/src/Admin.elm"];
  assert.deepEqual(unmetExpectations(elmRoot, unmet, left({ changed, committed })), [
    "src/Shapes.elm does not declare perimeter",
    "src/Shapes.elm still declares area",
    "area was also renamed or removed in src/Main.elm",
    "Shape in src/Shapes.elm has no variant Square",
    "Polygon is not the last variant of Shape in src/Shapes.elm",
    "Shape in src/Shapes.elm still has the variant Dot",
    "Square was also renamed or removed on Shape (src/Shapes.elm)",
    "the type Dot was also renamed or removed in src/Shapes.elm, src/Gone.elm",
    "Point in src/Shapes.elm has no field size",
    "Point in src/Shapes.elm still has the field label",
    "z was also renamed or removed on Point (src/Shapes.elm)",
    "src/Shapes.elm still exists",
    "src/Gone.elm does not declare the module Gone",
    "Shapes is still imported by src/Main.elm",
    "changed files that cannot use the target: src/Main.elm, ../admin/src/Admin.elm",
    "changed files that are no Elm sources of the project: data/prices.json, build.sh, ../README.md, ../admin/src/Admin.elm",
  ]);
  // A field can be used in any file, so a field rename names none that may change. Beside the project nothing may.
  assert.deepEqual(unmetExpectations(elmRoot, [{ kind: "only-elm-files" }], left({ changed: [file, "../admin/src/Admin.elm"], committed })), [
    "changed files that are no Elm sources of the project: ../admin/src/Admin.elm",
  ]);

  // A module that cannot use the target can name it in a comment, which a search and replace corrects. Its code
  // stays the same, also where its layout changed. A changed token there is a change to the code.
  const other = "module Other exposing (x)\n\n\n-- Not Shapes.area\nx =\n    1\n";
  const judgeOther = (after) => {
    writeFileSync(join(elmRoot, "src/Other.elm"), after);
    return unmetExpectations(elmRoot, [{ kind: "changes-only-in", files: [file] }], left({ changed: ["src/Other.elm"], originals: new Map([["src/Other.elm", other]]) }));
  };
  assert.deepEqual(judgeOther(other.replace("area", "perimeter")), []);
  assert.deepEqual(judgeOther(other.replace("x =\n    1", "x = 1")), []);
  assert.deepEqual(judgeOther(other.replace("    1", "    2")), ["changed files that cannot use the target: src/Other.elm"]);
});

test("a rename may change the name and the layout, and nothing else", (t) => {
  const elmRoot = tempDir(t);
  mkdirSync(join(elmRoot, "src"));
  const before = [
    "module Lib exposing (label, other)",
    "",
    "import Dict",
    "import Array",
    "",
    "",
    "{-| The label. -}",
    "label : String",
    "label =",
    '    "label"',
    "",
    "",
    "other : { label : String } -> String",
    "other record =",
    "    record.label ++ label",
    "",
  ].join("\n");
  const judge = (after, file = "src/Lib.elm", expectation = {}) => {
    writeFileSync(join(elmRoot, file), after);
    const renames = { kind: "renames-only", of: "function", from: "label", to: "title", ...expectation };
    return unmetExpectations(elmRoot, [renames], left({ changed: [file], originals: new Map([[file, before]]) }));
  };
  const renamed = before.replace("exposing (label,", "exposing (title,").replace("label : String\nlabel =", "title : String\ntitle =").replace("++ label", "++ title");

  assert.deepEqual(judge(renamed), []);
  // The field of the same name stayed, as it should. This check reads tokens: with the field renamed
  // too, still nothing but the name differs. Whether a namesake kept its name is for other expectations.
  assert.deepEqual(judge(renamed.replaceAll("label", "title").replace('"title"', '"label"')), []);
  // A formatter's doing, and a comment that follows the name
  assert.deepEqual(judge(renamed.replace("import Dict\nimport Array", "import Array\nimport Dict").replace("The label.", "The title.").replace("title =\n", "title =\n\n")), []);

  // A text replace reaches into the string as well, and the program then says something else
  assert.deepEqual(judge(before.replaceAll("label", "title")), ['src/Lib.elm changed in more than the name: "label" became "title"']);
  assert.deepEqual(judge(renamed.replace("record.label ++ title", "title")), ["src/Lib.elm changed in more than the name: record became title"]);
  assert.deepEqual(judge(renamed.replace("import Dict\n", "")), ['src/Lib.elm changed in more than the name: the module line and the imports no longer have "import Dict"']);
  assert.deepEqual(judge(renamed.replace("exposing (title, other)", "exposing (title)")), [
    'src/Lib.elm changed in more than the name: the module line and the imports no longer have "module Lib exposing (label, other)"',
  ]);
  assert.deepEqual(judge(renamed.replace("import Array", "import Array\nimport Set")), [
    'src/Lib.elm changed in more than the name: the module line and the imports gained "import Set"',
  ]);
  // Two imports that swap their aliases hold the same words as before, and the code below them means something else
  const aliased = (first, second) => `module Pair exposing (label)\n\nimport Left as ${first}\nimport Right as ${second} exposing (value)\n\n\nlabel =\n    A.value - B.value\n`;
  const pair = (after) => {
    writeFileSync(join(elmRoot, "src/Pair.elm"), after);
    const renames = { kind: "renames-only", of: "function", from: "label", to: "title" };
    return unmetExpectations(elmRoot, [renames], left({ changed: ["src/Pair.elm"], originals: new Map([["src/Pair.elm", aliased("A", "B")]]) }));
  };
  assert.deepEqual(pair(aliased("A", "B").replaceAll("label", "title")), []);
  assert.deepEqual(pair(aliased("B", "A").replaceAll("label", "title")), [
    'src/Pair.elm changed in more than the name: the module line and the imports no longer have "import Left as A"',
  ]);
  // An exposed name that goes from one import to the other
  assert.deepEqual(pair(aliased("A", "B").replace("import Left as A", "import Left as A exposing (value)").replace(" exposing (value)\n\n\n", "\n\n\n")), [
    'src/Pair.elm changed in more than the name: the module line and the imports no longer have "import Left as A"',
  ]);
  // Another name turned into the new one
  assert.deepEqual(judge(renamed.replace("other record =", "title record =")), ["src/Lib.elm changed in more than the name: other became title"]);

  // A module's name changes where it names the module, and a type of the same name keeps its own
  const shop = (module, type) =>
    `module Shop exposing (total)\n\nimport ${module} exposing (${type})\nimport Price\n\n\ntotal : ${type} -> ${module}.${type} -> Int\ntotal a b =\n    ${module}.price a + ${module}.price b\n`;
  const shopAfter = (after) => {
    writeFileSync(join(elmRoot, "src/Shop.elm"), after);
    const renames = { kind: "renames-only", of: "module", from: "Product", to: "ProductRenamed" };
    return unmetExpectations(elmRoot, [renames], left({ changed: ["src/Shop.elm"], originals: new Map([["src/Shop.elm", shop("Product", "Product")]]) }));
  };
  assert.deepEqual(shopAfter(shop("ProductRenamed", "Product")), []);
  // A replace of the whole word renames the type along, which compiles when it is done everywhere
  assert.deepEqual(shopAfter(shop("ProductRenamed", "ProductRenamed")), [
    'src/Shop.elm changed in more than the name: Product became ProductRenamed',
  ]);
  assert.deepEqual(shopAfter(shop("ProductRenamed", "Product").replace("total : Product", "total : ProductRenamed")), [
    "src/Shop.elm changed in more than the name: Product became ProductRenamed",
  ]);
  assert.deepEqual(shopAfter(shop("ProductRenamed", "Product").replace("exposing (Product)", "exposing (ProductRenamed)").replace("total : Product", "total : ProductRenamed")), [
    "src/Shop.elm changed in more than the name: Product became ProductRenamed",
  ]);
  assert.deepEqual(shopAfter(shop("ProductRenamed", "Product").replace("exposing (Product)", "exposing (ProductRenamed)")), [
    'src/Shop.elm changed in more than the name: the module line and the imports no longer have "import Product exposing (Product)"',
  ]);

  // A variant is named in no import, and a field in none and in no module line. An import alias of
  // the variant's name, or an exposed function of the field's, is another thing and keeps its name.
  const page = (alias, variant) =>
    `module Page exposing (Page(..), open)\n\nimport Page.Settings as ${alias}\n\n\ntype Page\n    = ${variant} ${alias}.Model\n    | Home\n\n\nopen : ${alias}.Model -> Page\nopen =\n    ${variant}\n`;
  const pageAfter = (after) => {
    writeFileSync(join(elmRoot, "src/Page.elm"), after);
    const renames = { kind: "renames-only", of: "variant", from: "Settings", to: "SettingsRenamed" };
    return unmetExpectations(elmRoot, [renames], left({ changed: ["src/Page.elm"], originals: new Map([["src/Page.elm", page("Settings", "Settings")]]) }));
  };
  assert.deepEqual(pageAfter(page("Settings", "SettingsRenamed")), []);
  assert.deepEqual(pageAfter(page("SettingsRenamed", "SettingsRenamed")), [
    'src/Page.elm changed in more than the name: the module line and the imports no longer have "import Page.Settings as Settings"',
  ]);
  assert.deepEqual(judge(renamed, "src/Lib.elm", { of: "field" }), [
    'src/Lib.elm changed in more than the name: the module line and the imports no longer have "module Lib exposing (label, other)"',
  ]);

  // A rename deletes no Elm file and creates none, whatever the compiler makes of that
  const stray = (file, original) =>
    unmetExpectations(elmRoot, [{ kind: "renames-only", of: "field", from: "label", to: "title" }], left({ changed: [file], originals: new Map([[file, original]]) }));
  assert.deepEqual(stray("src/Unused.elm", "module Unused exposing (unused)\n"), ["src/Unused.elm was deleted, which no rename asks for"]);
  writeFileSync(join(elmRoot, "src/Extra.elm"), "module Extra exposing (extra)\n");
  assert.deepEqual(stray("src/Extra.elm", null), ["src/Extra.elm is a new file, which no rename asks for"]);

  // A module that moved is compared with what it was at its old place
  const moved = (after) =>
    unmetExpectations(
      (writeFileSync(join(elmRoot, "src/LibRenamed.elm"), after), elmRoot),
      [{ kind: "renames-only", of: "module", from: "Lib", to: "LibRenamed", moved: ["src/Lib.elm", "src/LibRenamed.elm"] }],
      left({ changed: ["src/Lib.elm", "src/LibRenamed.elm"], originals: new Map([["src/Lib.elm", before], ["src/LibRenamed.elm", null]]) })
    );
  assert.deepEqual(moved(before.replace("module Lib ", "module LibRenamed ")), []);
  assert.deepEqual(moved(before.replace("module Lib ", "module LibRenamed ").replace('"label"', '"LibRenamed"')), [
    'src/LibRenamed.elm changed in more than the name: "label" became "LibRenamed"',
  ]);
  // The old file is the one a module rename deletes, and the new one the one it creates
  rmSync(join(elmRoot, "src/LibRenamed.elm"));
  const renames = { kind: "renames-only", of: "module", from: "Lib", to: "LibRenamed", moved: ["src/Lib.elm", "src/LibRenamed.elm"] };
  assert.deepEqual(unmetExpectations(elmRoot, [renames], left({ changed: ["src/Lib.elm", "src/LibRenamed.elm"], originals: new Map([["src/Lib.elm", before]]) })), [
    "src/LibRenamed.elm was deleted, which no rename asks for",
  ]);
  // A copy, with the old file left as it was. That the old file still exists is for another expectation to say.
  writeFileSync(join(elmRoot, "src/LibRenamed.elm"), before.replace("module Lib ", "module LibRenamed "));
  assert.deepEqual(unmetExpectations(elmRoot, [renames], left({ changed: ["src/LibRenamed.elm"], originals: new Map([["src/LibRenamed.elm", null]]) })), []);
});

test("a rename counts however the declaration is laid out afterwards", (t) => {
  const elmRoot = tempDir(t);
  mkdirSync(join(elmRoot, "src"));
  const file = "src/Choice.elm";
  writeFileSync(
    join(elmRoot, file),
    "module Choice exposing (..)\n\ntype Choice = FirstRenamed | Second | Third\n\ntype alias Pick = { chosenRenamed : Choice, at : Int }\n"
  );

  assert.deepEqual(
    unmetExpectations(
      elmRoot,
      [
        { kind: "type-has-variant", file, type: "Choice", variant: "FirstRenamed" },
        { kind: "type-lacks-variant", file, type: "Choice", variant: "First" },
        { kind: "alias-has-field", file, alias: "Pick", field: "chosenRenamed" },
        { kind: "alias-lacks-field", file, alias: "Pick", field: "chosen" },
      ],
      left({ changed: [file] })
    ),
    []
  );
});

test("a module rename changes elm.json where a package lists the module, and nowhere else", (t) => {
  const elmRoot = tempDir(t);
  const elmJson = {
    type: "package",
    "exposed-modules": { Shapes: ["Shape", "Shape.Round"], Other: ["Point"] },
    dependencies: { "elm/core": "1.0.0 <= v < 2.0.0" },
  };
  const judge = (after, changed = ["elm.json"], from = "Shape") => {
    writeFileSync(join(elmRoot, "elm.json"), typeof after === "string" ? after : JSON.stringify(after, null, 4));
    const expectation = { kind: "elm-json-renames-only", from, to: `${from}Renamed` };
    // The starting text is kept of a file that changed, and of no other
    const originals = new Map(changed.map((file) => [file, JSON.stringify(elmJson)]));
    return unmetExpectations(elmRoot, [expectation], left({ changed, originals }));
  };
  const renamed = { ...elmJson, "exposed-modules": { Shapes: ["ShapeRenamed", "Shape.Round"], Other: ["Point"] } };
  const more = ["elm.json changed in more than the name of Shape among the modules it exposes"];

  // Written out anew with other spacing, it still says the same
  assert.deepEqual(judge(renamed), []);
  // A build of one file does not read the list, so the old name in it is found here: in a file
  // that was left alone, and in one that was written out anew
  const stale = ["elm.json still lists Shape among the modules it exposes"];
  assert.deepEqual(judge(elmJson, []), stale);
  assert.deepEqual(judge(elmJson), stale);
  // A module that the package keeps to itself has no name there, and an application lists none
  assert.deepEqual(judge(elmJson, [], "Inner"), []);
  assert.deepEqual(judge({ type: "application", "source-directories": ["src"] }, []), []);
  assert.deepEqual(judge({ ...renamed, dependencies: { ...elmJson.dependencies, "elm/json": "1.0.0 <= v < 2.0.0" } }), more);
  assert.deepEqual(judge({ ...renamed, "source-directories": ["src", "more"] }), more);
  assert.deepEqual(judge({ ...elmJson, "exposed-modules": { Shapes: ["ShapeRenamed", "Shape.RoundRenamed"], Other: ["Point"] } }), more);
  // A module that the package does not expose is not added to the list by its rename
  assert.deepEqual(judge({ ...renamed, "exposed-modules": { ...renamed["exposed-modules"], Other: ["Point", "ShapeRenamed"] } }), more);
  assert.deepEqual(judge("{"), more);
});

// A patch that adds the given lines to src/View.elm and removes the others.
const patchOfLines = (added, removed = []) =>
  ["diff --git a/src/View.elm b/src/View.elm", "--- a/src/View.elm", "+++ b/src/View.elm", "@@ -10,3 +10,9 @@ view shape =", " context", ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");

test("the add-variant task is solved by the variant and its branches, and by nothing else", () => {
  const judge = (patch) => unmetExpectations("/nowhere", [{ kind: "adds-variant-and-branches", variant: "Dot" }], left({ patch }));
  const variant = "    | Dot";
  const branch = ["", "        Dot ->", '            Debug.todo "Dot"'];

  assert.deepEqual(judge(patchOfLines([variant, ...branch, "", '        ( Shapes.Dot, _ ) -> Debug.todo "Dot"'])), []);
  // A type written without a space behind its bars takes the variant in its own style
  assert.deepEqual(judge(patchOfLines(["    |Dot", ...branch])), []);
  assert.deepEqual(judge(`${patchOfLines(["    |Dot", ...branch])}\n${patchOfLines(["    |  Dot"]).replaceAll("View.elm", "Other.elm")}`), [
    "Dot was added 2 times, and one type was to get it",
  ]);

  // The build also passes with a catch-all, with an existing branch rewritten, or with the text in a comment
  assert.deepEqual(judge(patchOfLines([variant, "        _ ->", "            0"])), [
    "changed more than the variant and its branches: +_ -> / +0",
  ]);
  assert.deepEqual(judge(patchOfLines([variant, "        _ ->", "            0", '        -- Debug.todo "Dot"'], ["        Circle _ ->"])), [
    'changed more than the variant and its branches: -Circle _ -> / +_ -> / +0 / +-- Debug.todo "Dot"',
  ]);
  assert.deepEqual(judge(patchOfLines([variant])), ["no branch for Dot was added"]);
  // A catch-all that only carries the name: in a comment, or in the body it reaches
  assert.deepEqual(judge(patchOfLines([variant, "        _ {- Dot -} ->", '            Debug.todo "Dot"'])), [
    'changed more than the variant and its branches: +_ {- Dot -} -> / +Debug.todo "Dot"',
  ]);
  assert.deepEqual(judge(patchOfLines([variant, '        _ -> Debug.todo "Dot"'])), [
    'changed more than the variant and its branches: +_ -> Debug.todo "Dot"',
  ]);
  // A pattern can take several lines while one of its brackets is open, and is a branch for the variant all the same
  const tuple = ["        ( Dot", "            , _", "            ) ->", '            Debug.todo "Dot"'];
  assert.deepEqual(judge(patchOfLines([variant, ...branch, "", ...tuple])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        ( Shapes.Dot", '        ) -> Debug.todo "Dot"', ...branch])), []);
  // One that does not name the variant is none, nor is one with a comment line in it or with more than a pattern
  const more = (...lines) => [`changed more than the variant and its branches: ${lines.map((line) => `+${line}`).join(" / ")}`];
  assert.deepEqual(judge(patchOfLines([variant, "        ( _", "            , _", "            ) ->", "            0"])), more("( _", ", _", ") ->", "0"));
  assert.deepEqual(judge(patchOfLines([variant, "        ( Dot", "            -- or none", '            ) -> Debug.todo "Dot"'])), more("( Dot", "-- or none", ') -> Debug.todo "Dot"'));
  assert.deepEqual(judge(patchOfLines([variant, "        ( Dot", "            , _", '            |> ) -> Debug.todo "Dot"'])), more("( Dot", ", _", '|> ) -> Debug.todo "Dot"'));
  // A comment that begins and ends on one line of a pattern is passed over, since a pattern is read line by line
  // without its comments. One that goes on over two lines of it is not, and behind the arrow, in the body and
  // behind the new variant a comment is one more thing that changed.
  const body = '            Debug.todo "Dot"';
  assert.deepEqual(judge(patchOfLines([variant, "        {- new -} Dot {- new -} ->", body, "        ( Dot -- new", "        {- new -} , _ ) ->", body])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        ( Dot {- a", "          comment -} ) ->", body])), more("( Dot {- a", "comment -} ) ->", 'Debug.todo "Dot"'));
  assert.deepEqual(judge(patchOfLines([variant, "        Dot -> -- new", body])), more("Dot -> -- new", 'Debug.todo "Dot"'));
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", `${body} -- new`])), ["a branch for Dot is followed by something else than a Debug.todo with a message"]);
  assert.deepEqual(judge(patchOfLines([`${variant} -- new`, "        Dot ->", body])), more("| Dot -- new"));
  // A bracket that stays open is no pattern, and a line above a branch is none of its pattern
  assert.deepEqual(judge(patchOfLines([variant, ...branch, "        ( Dot", "            , _"])), more("( Dot", ", _"));
  assert.deepEqual(judge(patchOfLines([variant, "            other", ...branch.slice(1)])), more("other"));
  // Each branch has its own body, right behind it
  const noBody = "a branch for Dot is followed by something else than a Debug.todo with a message";
  // The message is the session's choice. The language server's own tool writes "Handle Dot".
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            Debug.todo "Handle Dot"', '        ( Dot, _ ) -> Debug.todo ""'])), []);
  // Brackets around the call change nothing
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            (Debug.todo "handle (new) shape")', '        ( Dot, _ ) -> ( (Debug.todo "x") )'])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            (Debug.todo "x"'])), [noBody]);
  // A formatter leaves the message on a line of its own, and a bracket where it was put
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo", '                "Handle Dot"', "        ( Dot, _ ) -> Debug.todo", '            "x"'])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            (", "                Debug.todo", "", '                    "x"', "            )"])), []);
  // Brackets around the message or the function, and a message in three quotes, which can go on over lines
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            Debug.todo ("new")', '        ( Dot, _ ) -> (Debug.todo) ("""x""")'])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo", '                """a "new" shape', "        Dot -> is no branch here", '                """'])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            Debug.todo """a new shape'])), [noBody]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            Debug.todo ("x") "y"'])), [noBody]);
  // The message handed over with "<|", which stands behind the call and nowhere else
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo <|", '                "new"', '        ( Dot, _ ) -> Debug.todo <| ("x")'])), []);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", '            Debug.todo "x" <| "y"'])), [noBody]);
  // Such a body is over with its message, and with the last of its brackets
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo", '                "x"', '                "y"'])), ['changed more than the variant and its branches: +"y"']);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            (Debug.todo", '                "x"', "            ))"])), [noBody]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo"])), [noBody]);
  // It goes on in the lines right below its branch. A blank line of the file between them is still that,
  // and a line with something on it is not, nor is a line of another file.
  const around = (context) => [...patchOfLines([variant, "        Dot ->", "            Debug.todo"]).split("\n"), context, '+                "x"'].join("\n");
  assert.deepEqual(judge(around(" ")), []);
  assert.deepEqual(judge(around("             |> identity")), ['changed more than the variant and its branches: +"x"']);
  assert.deepEqual(judge(`${patchOfLines([variant, "        Dot ->", "            Debug.todo"])}\n${patchOfLines(['    "x"']).replaceAll("View.elm", "Other.elm")}`), [
    'changed more than the variant and its branches: +"x"',
  ]);
  // One type was to get the variant. A namesake of it in another module takes it just as well, and the project compiles.
  assert.deepEqual(judge(`${patchOfLines([variant, ...branch])}\n${patchOfLines([variant]).replaceAll("View.elm", "Other.elm")}`), [
    "Dot was added 2 times, and one type was to get it",
  ]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            Debug.todo oops"])), [noBody]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "        Dot ->", '            Debug.todo "Dot"'])), [noBody]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->", "            0"])), [noBody]);
  assert.deepEqual(judge(patchOfLines([variant, "        Dot ->"])), [noBody]);
  // A file that did not end in a line break has its last line shown as removed and added again
  const unended = ["diff --git a/src/Shapes.elm b/src/Shapes.elm", "@@ -5,3 +5,4 @@ type Shape", "     = Circle", "-    | Square", "\\ No newline at end of file", "+    | Square", "+    | Dot", "\\ No newline at end of file"].join("\n");
  assert.deepEqual(judge(`${unended}\n${patchOfLines(branch)}`), []);
  assert.deepEqual(judge(`${unended.replace("+    | Square", "+    | Squared")}\n${patchOfLines(branch)}`), [
    "changed more than the variant and its branches: -| Square / +| Squared",
  ]);
  // The other way round, a last line that lost its line break is shown the same way, and did not change either
  const dropped = ["diff --git a/src/Main.elm b/src/Main.elm", "@@ -8,3 +8,3 @@ main =", "     [ view", "-    ]", "+    ]", "\\ No newline at end of file"].join("\n");
  assert.deepEqual(judge(`${patchOfLines([variant, ...branch])}\n${dropped}`), []);
  assert.deepEqual(judge(`${patchOfLines([variant, ...branch])}\n${dropped.replace("+    ]", "+    ] ++ more")}`), [
    "changed more than the variant and its branches: -] / +] ++ more",
  ]);
  // A line that was removed further up is no match for it
  const moved = dropped.replace("-    ]", "-    ]\n     , footer");
  assert.deepEqual(judge(`${patchOfLines([variant, ...branch])}\n${moved}`), ["changed more than the variant and its branches: -] / +]"]);
  // A file header of the patch is no removed line
  assert.deepEqual(judge(patchOfLines([variant, ...branch]).replace("--- a/src/View.elm", "--- /dev/null")), []);
  // Only Elm files count. A note the agent left elsewhere is none of this check's business.
  const note = ["diff --git a/NOTES.md b/NOTES.md", "--- /dev/null", "+++ b/NOTES.md", "@@ -0,0 +1 @@", "+Added the variant."].join("\n");
  assert.deepEqual(judge(`${patchOfLines([variant, ...branch])}\n${note}`), []);
});
