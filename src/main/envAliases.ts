/**
 * Rebrand compatibility: every `FRAMEWRIGHT_<X>` environment variable is also exposed as `PALMIER_<X>` (the name
 * the code reads), unless `PALMIER_<X>` is set explicitly. Imported first by src/main/index.ts so modules that
 * read the environment at load time, and child processes (workers, ML helpers), see the aliases.
 */
export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('FRAMEWRIGHT_') || value === undefined) continue
    const legacy = `PALMIER_${key.slice('FRAMEWRIGHT_'.length)}`
    if (env[legacy] === undefined) env[legacy] = value
  }
}

applyEnvAliases()
