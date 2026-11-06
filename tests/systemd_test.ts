import { defaultConfig } from "../src/config.ts";
import { systemdAssets } from "../src/install.ts";
import { assert, temporary } from "./helpers.ts";

const analyzer = "/usr/bin/systemd-analyze";
let available = false;
try {
  available = (await Deno.stat(analyzer)).isFile;
} catch { /* Container profile has no systemd. */ }

Deno.test({
  name: "generated units pass real systemd verification with spaces and literal specifiers",
  ignore: !available,
  fn: () =>
    temporary(async (root) => {
      const repo = `${root}/instance with space %n $HOME`;
      const c = defaultConfig(`${root}/payload with space %n $HOME`, "demo");
      c.host = {
        user: "fixture",
        home: `${root}/home with space`,
        swamp: "/bin/true",
        node: "/bin/true",
        torlinkDir: `${root}/downloader with space %n`,
        vpnCountry: "Netherlands",
        vpnCity: "Amsterdam",
      };
      c.torlink.binary = "/bin/true";
      await systemdAssets(c, repo);
      const paths = ["hoardarr-swamp.service", "torlink.service"].map((name) =>
        `${repo}/assets/systemd/${name}`
      );
      const result = await new Deno.Command(analyzer, {
        args: ["--system", "--man=no", "verify", ...paths],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const diagnostics = new TextDecoder().decode(result.stderr);
      assert(result.success && !diagnostics.trim(), diagnostics);
      const unit = await Deno.readTextFile(paths[0]);
      assert(
        unit.includes('instance with space %%n $$HOME"'),
        "ExecStart expands literal user path characters",
      );
    }),
});
