/**
 * Tests of benchmarks/lib/elm-source.mjs, which reads Elm sources without a
 * compiler. They start no process and read no clock.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, headerLine, literalLineStarts, scanSource, tokensOf, withVariant } from "../benchmarks/lib/elm-source.mjs";
import { SHAPES, SPREAD } from "./benchmark-support.mjs";

test("a source file is read for its module, imports, functions, variants and fields", () => {
  const { text, code, imported, codeWithoutImports, ...scanned } = scanSource("src/Shapes.elm", SHAPES);
  assert.deepEqual(scanned, {
    file: "src/Shapes.elm",
    module: "Shapes",
    imports: ["Json.Decode", "Html"],
    functions: ["area"],
    exposedFunctions: ["area"],
    typeNames: ["Shape", "Point", "Id"],
    openFields: [],
    // The fields of Polygon's record argument are not variants
    types: [{ name: "Shape", variants: ["Circle", "Polygon", "Dot"], open: true }],
    // The fields of the nested label record are not fields of Point, and Id is no record
    aliases: [{ name: "Point", fields: ["x", "y", "label"] }],
  });
  assert.equal(text, SHAPES);
  assert.equal(code, SHAPES);
  // How each module is imported is read once, for every name that is looked up in the file
  assert.deepEqual(
    imported,
    new Map([
      ["Json.Decode", { qualifier: "Decode", everything: false, names: ["Decoder"], constructorsOf: [] }],
      ["Html", { qualifier: "Html", everything: false, names: [], constructorsOf: [] }],
    ])
  );
  assert.equal(codeWithoutImports, SHAPES.replace("import Json.Decode as Decode exposing (Decoder)\nimport Html\n", ""));
  // Of two imports of one module, the first counts
  const twice = scanSource("src/Twice.elm", "module Twice exposing (..)\n\nimport Html as H\nimport Html as Markup exposing (..)\n");
  assert.deepEqual(twice.imported.get("Html"), { qualifier: "H", everything: false, names: [], constructorsOf: [] });
  assert.equal(scanSource("notes.elm", "-- no module line here"), null);
  // Another module can name the variants of a type only where the module line exposes them
  const open = (exposing) => scanSource("src/Email.elm", `module Email exposing\n    (${exposing})\n\n\ntype Email\n    = Email String\n`).types[0].open;
  assert.deepEqual(["Email, fromString", "fromString, Email(..)", ".."].map(open), [false, true, true]);
  // And a function only where the module line names it, or everything
  const exposed = (exposing) => scanSource("src/Lib.elm", `module Lib exposing (${exposing})\n\n\none : Int\none =\n    1\n\n\ntwo : Int\ntwo =\n    2\n`).exposedFunctions;
  assert.deepEqual(["one", "Two, two", ".."].map(exposed), [["one"], ["two"], ["one", "two"]]);
  // A function from one record to another begins and ends like a record, and is none. A record can hold a function.
  const aliases = (body) => scanSource("src/Lib.elm", `module Lib exposing (..)\n\n\ntype alias Turn =\n    ${body}\n`).aliases;
  assert.deepEqual(aliases("{ name : String } -> { name : String }"), []);
  assert.deepEqual(aliases("{ name : String, turn : Int -> Int }"), [{ name: "Turn", fields: ["name", "turn"] }]);
});

test("a name in letters outside ASCII is read whole", () => {
  const salle = [
    "module Café.Salle exposing (État(..), Réservation, libellé)",
    "",
    "import Données.Clés as Clés exposing (Clé(..), ouvre)",
    "",
    "",
    "type État",
    "    = Ouverte",
    "    | Fermée",
    "",
    "",
    "type alias Réservation =",
    "    { prénom : String",
    "    , entrée : Int",
    "    }",
    "",
    "",
    "libellé : État -> { r | durée : Int } -> String",
    "libellé état _ =",
    '    "Fermée"',
    "",
  ].join("\n");
  const { text, code, imported, codeWithoutImports, ...scanned } = scanSource("src/Café/Salle.elm", salle);
  assert.deepEqual(scanned, {
    file: "src/Café/Salle.elm",
    module: "Café.Salle",
    imports: ["Données.Clés"],
    functions: ["libellé"],
    exposedFunctions: ["libellé"],
    typeNames: ["État", "Réservation"],
    openFields: ["durée"],
    types: [{ name: "État", variants: ["Ouverte", "Fermée"], open: true }],
    aliases: [{ name: "Réservation", fields: ["prénom", "entrée"] }],
  });
  assert.equal(text, salle);
  assert.equal(code, salle.replace('"Fermée"', "        "));
  // A name is one token, whatever its letters
  assert.deepEqual(tokensOf("libellé état =\n    Clés.ouvre Fermée\n").body, ["libellé", "état", "=", "Clés", ".", "ouvre", "Fermée"]);
  assert.equal(headerLine(tokensOf(salle).header[1]), "import Données.Clés as Clés exposing (Clé(..), ouvre)");
  assert.match(withVariant(salle, "État", "Complète"), /^    \| Fermée\n    \| Complète$/m);
});

test("a declaration reads the same however it is laid out", () => {
  const oneLine = [
    "module Shapes exposing (..)",
    "",
    "type Shape = Circle Float | Polygon { sides : Int, length : Float } | Dot",
    "",
    "type alias Point = { x : Float, y : Float, label : { text : String, size : Int } }",
    "",
    "type alias Named a = { a | name : String, tags : List ( String, Int ) }",
    "",
    "type alias Id = Int",
    "",
    "heading : { r | title : String, at : { x : Int, y : Int } } -> Point -> Point",
    "heading record point = { point | x = 1, y = 2 }",
  ].join("\n");

  const { types, aliases, openFields } = scanSource("src/Shapes.elm", oneLine);
  assert.deepEqual(types, [{ name: "Shape", variants: ["Circle", "Polygon", "Dot"], open: true }]);
  // An extensible record stands for every record with its fields, so it has none of its own to rename
  assert.deepEqual(aliases, [{ name: "Point", fields: ["x", "y", "label"] }]);
  // What an extensible record type asks of any record, in an alias or in an annotation. A record update is no type.
  assert.deepEqual(openFields, ["name", "tags", "title", "at"]);

  // The head of a declaration can be spread over lines as well
  const { text, code, imported, codeWithoutImports, ...spread } = scanSource("src/Layout.elm", SPREAD);
  assert.deepEqual(spread, {
    file: "src/Layout.elm",
    module: "Layout",
    imports: ["Html"],
    functions: ["area", "hidden"],
    exposedFunctions: ["area"],
    typeNames: ["Shape", "Point"],
    openFields: [],
    types: [{ name: "Shape", variants: ["Circle", "Dot"], open: true }],
    aliases: [{ name: "Point", fields: ["x", "y"] }],
  });
});

test("the lines that begin inside a string literal are found, an empty one among them, and none in a comment", () => {
  assert.deepEqual([...literalLineStarts('one = "one"\nexample =\n    """one\n\nthree"""\n{- a\n\ncomment -}\n')], [3, 4]);
});

test("comments and literals are no code", () => {
  const source = [
    "module Notes exposing (..)",
    "",
    "{-| Was once: type Old = Gone | Away",
    "   {- and import Nested -}",
    "-}",
    "type Kind",
    "    = Real -- | Commented",
    "    | Other",
    "",
    "-- helper : Int",
    'text = "import Fake" ++ """',
    "type alias InString = { a : Int }",
    '""" ++ String.fromChar \'"\' ++ "it\\"s -- no comment"',
  ].join("\n");

  const { types, aliases, imports, functions } = scanSource("src/Notes.elm", source);
  assert.deepEqual({ types, aliases, imports, functions }, {
    types: [{ name: "Kind", variants: ["Real", "Other"], open: true }],
    aliases: [],
    imports: [],
    functions: [],
  });
  // Blanked, not cut: every line keeps its place and its length
  assert.deepEqual(codeOnly(source).split("\n").map((line) => line.length), source.split("\n").map((line) => line.length));
  assert.equal(codeOnly(source).split("\n")[6], "    = Real               ");
});

test("a text is read as its tokens, with the module line and the imports apart", () => {
  const text = [
    "port module Main exposing (main, out)",
    "",
    "import Zebra exposing (stripe, mane)",
    "import Ant as A",
    "",
    "{-| A comment, which is no token. -}",
    "main : String",
    "main =",
    '    -- nor is this one',
    "    \"a -- b\" ++ A.name 1.5e3 'x'",
    "",
    "port out : String -> Cmd msg",
    "",
  ].join("\n");
  const { header, body } = tokensOf(text);
  assert.deepEqual(body, ["main", ":", "String", "main", "=", '"a -- b"', "+", "+", "A", ".", "name", "1.5e3", "'x'", "port", "out", ":", "String", "-", ">", "Cmd", "msg"]);
  // Each line of the header on its own, with what it exposes in one order whatever the source has
  assert.deepEqual(header.map(headerLine), ["port module Main exposing (main, out)", "import Zebra exposing (mane, stripe)", "import Ant as A"]);
  assert.equal(headerLine(tokensOf("module Shapes exposing (area, Shape(..), Point)\n").header[0]), "module Shapes exposing (Point, Shape(..), area)");

  // A quote behind a backslash ends neither kind of literal
  assert.deepEqual(tokensOf('x =\n    """a \\""" b""" ++ String.fromChar \'\\\'\' ++ "c"\n').body, [
    "x",
    "=",
    '"""a \\""" b"""',
    "+",
    "+",
    "String",
    ".",
    "fromChar",
    "'\\''",
    "+",
    "+",
    '"c"',
  ]);

  // Laid out differently, it has the same tokens
  const relaid = text.replace("import Zebra exposing (stripe, mane)", "import Zebra\n    exposing\n        ( stripe\n        , mane\n        )").replace("main =\n", "main =\n\n\n");
  assert.deepEqual(tokensOf(relaid), tokensOf(text));
});

test("a variant is appended below the last one, after its wrapped arguments", () => {
  const source = ["type Shape", "    = Circle Float", "    | Polygon", "        { sides : Int", "        }", "", "", "x = 1"].join("\n");
  assert.equal(
    withVariant(source, "Shape", "Dot"),
    ["type Shape", "    = Circle Float", "    | Polygon", "        { sides : Int", "        }", "    | Dot", "", "", "x = 1"].join("\n")
  );
  assert.equal(withVariant(source, "Colour", "Dot"), null);
  // The arguments of the last variant end where the declaration's code ends, also below a blank line
  const spaced = ["type Shape", "    = Circle Float", "    | Triangle", "", "        String", "", "", "x = 1"].join("\n");
  assert.equal(
    withVariant(spaced, "Shape", "Dot"),
    ["type Shape", "    = Circle Float", "    | Triangle", "", "        String", "    | Dot", "", "", "x = 1"].join("\n")
  );
  assert.equal(withVariant("type alias Shape =\n    Int\n", "Shape", "Dot"), null);

  // A type in a comment or in a string above the declaration is an example, and keeps its variants
  const example = ["type Shape", "    = Circle", "    | Square"];
  const declared = ["type Shape", "    = Circle Float", "    | Polygon", "        -- how many", "        Int", "-- what follows", "x = 1"];
  const appended = ["type Shape", "    = Circle Float", "    | Polygon", "        -- how many", "        Int", "    | Dot", "-- what follows", "x = 1"];
  for (const [open, close] of [["{-", "-}"], ['doc = """', '"""']]) {
    const documented = [open, ...example, close, "", "", ...declared].join("\n");
    assert.equal(withVariant(documented, "Shape", "Dot"), [open, ...example, close, "", "", ...appended].join("\n"), open);
    assert.equal(withVariant([open, ...example, close, ""].join("\n"), "Shape", "Dot"), null, open);
  }
});
