/** send_feedback: validated and de-duplicated like the Mac, but nothing leaves the machine on Linux. */
import { ToolError, lenient, type Obj } from './args'
import { ok, type ToolEnv, type ToolResult } from './context'
import { APP_NAME } from '../../../shared/brand'

const CATEGORIES = ['confusing_ux', 'failure', 'missing_capability', 'suggestion', 'wrong_result']
const SEVERITIES = ['low', 'medium', 'high']
const MAX_PER_SESSION = 8

export function sendFeedback(env: ToolEnv, args: Obj): ToolResult {
  const category = lenient.requireString(args, 'category').trim()
  if (!CATEGORIES.includes(category)) throw new ToolError(`Invalid category '${category}'. Expected one of: ${CATEGORIES.join(', ')}.`)
  const summary = lenient.requireString(args, 'summary').trim()
  if (!summary) throw new ToolError('summary must not be empty.')
  const severity = lenient.string(args, 'severity')?.trim()
  if (severity !== undefined && !SEVERITIES.includes(severity)) throw new ToolError(`Invalid severity '${severity}'. Expected low, medium, or high.`)
  const key = `${category}|${summary}`
  if (env.feedback.sentKeys.has(key)) return ok('Already flagged this to the team this session — not sending a duplicate.')
  if (env.feedback.sentKeys.size >= MAX_PER_SESSION) return ok('Feedback limit reached for this session. Summarize any remaining issues to the user instead of sending more.')
  env.feedback.sentKeys.add(key)
  return ok(`Noted, but this Linux build doesn't send feedback to the ${APP_NAME} team, so nothing was transmitted. Mention the issue to the user instead.`)
}
