import { readConfig } from "../../src/config.ts";
import { configurationPath, guestAssets } from "../../src/native.ts";
import { readGuestIdentity } from "../../extensions/models/_lib/guest.ts";
const repo = Deno.args[0];
if (!repo?.startsWith("/")) throw new Error("Supply the native checkout path");
const config=await readConfig(await configurationPath(repo));
const output=Deno.args[1];
if (output) {
  if(Deno.uid()!==0 || output!=="/run/hoardarr/generated") throw new Error("Protected asset generation requires the fixed root staging directory");
  const identity=await readGuestIdentity(),g=config.guest;
  if (!g || g.installationId!==identity.installationId || g.projectRoot!==identity.projectRoot || g.repoRoot!==identity.repoRoot || g.user!==identity.user || g.uid!==identity.uid || g.gid!==identity.gid || g.purpose!==identity.purpose || g.vpnInterface!==identity.vpnInterface || g.vpnProtocol!==identity.vpnProtocol || repo!==identity.repoRoot) throw new Error("Configuration differs from the protected service identity");
  const stat=await Deno.lstat(`${g.projectRoot}/hoardarr.yaml`);
  if (!stat.isFile || stat.isSymlink || stat.uid!==g.uid) throw new Error("Untrusted native configuration file");
}
await guestAssets(config,repo,output);
