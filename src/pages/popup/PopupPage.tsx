import { useAgentRunner } from '../../features/agent-runner/model'
import { starterSuggestions } from '../../processes/chat-session/suggestions'
import { ChatShell } from '../../widgets/chat-shell/ChatShell'

export function PopupPage() {
  const agent = useAgentRunner()

  return (
    <ChatShell
      extensionReady={agent.extensionReady}
      isRunning={agent.isRunning}
      messages={agent.messages}
      mode={agent.mode}
      statusText={agent.statusText}
      suggestions={starterSuggestions}
      task={agent.task}
      onModeChange={agent.setMode}
      onSubmit={agent.runAgent}
      onSuggestion={agent.applySuggestion}
      onTaskChange={agent.updateTask}
    />
  )
}
