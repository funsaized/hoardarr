import {
  commandGroups,
  operationCatalog,
  operationForm,
  operationInputs,
  stepDescriptions,
  workflowDescriptions,
} from "../deploy/board/reference.js";
import { workflowReference } from "../src/workflows.ts";
import { defaultConfig } from "../src/config.ts";
import { nativeConfig } from "./native_config.ts";

Deno.test("reference explains every installed workflow step without publishing configuration inputs", () => {
  const path = "/private/board-reference-test";
  const native = nativeConfig(path);
  native.movieReleaseFeeds = ["private-feed"];
  native.interests.shows = [{ name: "Private interests", category: "tv" }];
  const nativeSteps = workflowReference(native).flatMap((workflow) => workflow.steps);
  for (
    const method of [
      "pipeline.ingestReleaseFeeds",
      "pipeline.linkMovieAliases",
      "tracked-tv.refresh",
    ]
  ) {
    if (!nativeSteps.some((step) => step.command === method)) throw Error("Missing " + method);
  }
  for (
    const config of [native, defaultConfig(path, "demo"), defaultConfig(path, "compose-vpn-local")]
  ) {
    for (const workflow of workflowReference(config)) {
      if (!Object.hasOwn(workflowDescriptions, workflow.name)) throw Error(workflow.name);
      for (const step of workflow.steps) {
        if (
          !Object.hasOwn(stepDescriptions, step.command) &&
          !Object.hasOwn(stepDescriptions, step.name) &&
          !Object.hasOwn(workflowDescriptions, step.command)
        ) throw Error("Missing description for " + step.command);
      }
      if (/private|\$\{\{/.test(JSON.stringify(workflow))) {
        throw Error("Unexpected workflow inputs");
      }
    }
  }
});

Deno.test("every command in operator help has a board reference entry", async () => {
  const help = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "cli/main.ts", "help"],
  });
  const result = await help.output();
  if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
  const forms = commandGroups.flatMap(([, entries]) =>
    (entries as string[][]).map(([form]) => form.split(" ")[0])
  );
  const helpText = new TextDecoder().decode(result.stdout);
  const entries = commandGroups.flatMap(([, group]) => (group as string[][]).map(([form]) => form));
  for (const operation of operationCatalog.operations) {
    const [form] = operationForm(operation.command);
    if (!helpText.includes(form) || !entries.includes(form)) {
      throw Error("Missing operator form " + form);
    }
  }
  for (const operation of ["request replace", "resolve link"]) {
    try {
      operationInputs(operation, []);
    } catch {
      continue;
    }
    throw Error("Accepted an empty command");
  }
  for (const line of helpText.split("\n")) {
    const action = /^([a-z][-a-z]+)\s/.exec(line)?.[1];
    if (action && !forms.includes(action)) throw Error("Missing command " + action);
  }
});
