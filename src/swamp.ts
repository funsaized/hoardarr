/** CLI boundary for installation and operator commands, never called from behavior methods. */
export async function swamp(
  args: string[],
  repo?: string,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(Deno.env.get("HOARDARR_SWAMP") ?? "swamp", {
    args: [...args, ...(repo ? ["--repo-dir", repo] : [])],
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}
export async function command(args: string[], repo?: string, input?: string): Promise<string> {
  const result = await swamp(args, repo, input);
  if (result.code !== 0) {
    throw new Error(`swamp ${args.slice(0, 3).join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
export async function jsonCommand<T = Record<string, unknown>>(
  args: string[],
  repo?: string,
  input?: string,
): Promise<T> {
  return JSON.parse(await command([...args, "--json"], repo, input));
}
