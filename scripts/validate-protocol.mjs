import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import YAML from "yaml";

const root = process.cwd();
const specPath = path.join(root, "docs/protocol/openapi.yaml");
const fixtureDir = path.join(root, "docs/protocol/fixtures");
const source = await readFile(specPath, "utf8");
const parsed = YAML.parse(source);
const api = await SwaggerParser.dereference(parsed);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const fixtureSchemas = {
  "config-success.json": "WatchConfig",
  "empty-selection.json": "PlaylistPage",
  "pair-success.json": "PairResponse",
  "playlists-success.json": "PlaylistPage",
  "protocol-mismatch.json": "ErrorResponse",
  "sync-result-storage-insufficient.json": "SyncResultRequest",
  "sync-result-timings.json": "SyncResultRequest",
  "sync-result-success.json": "SyncResultResponse",
  "tracks-success.json": "TrackPage"
};

for (const [filename, schemaName] of Object.entries(fixtureSchemas)) {
  const body = JSON.parse(await readFile(path.join(fixtureDir, filename), "utf8"));
  const validate = ajv.compile(api.components.schemas[schemaName]);
  if (!validate(body)) {
    throw new Error(`${filename} failed ${schemaName}: ${ajv.errorsText(validate.errors)}`);
  }
}

const errorCases = JSON.parse(
  await readFile(path.join(fixtureDir, "errors.json"), "utf8")
);
const validateError = ajv.compile(api.components.schemas.ErrorResponse);
for (const fixture of errorCases) {
  if (!validateError(fixture.body)) {
    throw new Error(
      `errors.json ${fixture.body?.error?.code ?? "unknown"}: ${ajv.errorsText(validateError.errors)}`
    );
  }
}

const scenarioFiles = (await readdir(fixtureDir)).filter((name) =>
  name.endsWith("-scenario.json")
);
const validateScenario = ajv.compile(api.components.schemas.ProtocolScenario);
for (const filename of scenarioFiles) {
  const body = JSON.parse(await readFile(path.join(fixtureDir, filename), "utf8"));
  if (!validateScenario(body)) {
    throw new Error(`${filename}: ${ajv.errorsText(validateScenario.errors)}`);
  }
}

console.log(
  `Validated OpenAPI and ${Object.keys(fixtureSchemas).length + errorCases.length + scenarioFiles.length} fixtures.`
);
