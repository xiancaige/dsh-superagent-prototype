/** Per-child Feishu CLI configuration; never changes the host environment. */
export function feishuEnvironment(configDir?: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
  if (!configDir) return env
  // DSH may inherit another agent's workspace markers. Undefined entries are tombstones
  // for the subprocess service's ambient environment, not just omissions from this object.
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(base), 'HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL',
    'LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET', 'LARKSUITE_CLI_TOKEN', 'LARKSUITE_CLI_ACCESS_TOKEN', 'LARKSUITE_CLI_USER_ACCESS_TOKEN'])) {
    if (/^(HERMES_HOME|OPENCLAW_HOME|LARK_CHANNEL)$/i.test(key)
      || /^LARKSUITE_CLI_.*(?:SECRET|TOKEN|APP_ID|CLIENT_ID)/i.test(key)) env[key] = undefined
  }
  env.LARKSUITE_CLI_CONFIG_DIR = configDir
  return env
}
