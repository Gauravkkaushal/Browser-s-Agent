import { useAgentRunner } from '../../features/agent-runner/model'
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
      task={agent.task}
      maskedScreenshot={agent.maskedScreenshot}
      maskedCount={agent.maskedCount}
      onModeChange={agent.setMode}
      onSubmit={agent.runAgent}
      onTaskChange={agent.updateTask}
    />
  )
}
