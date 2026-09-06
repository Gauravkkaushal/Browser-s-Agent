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
      pageLine={agent.pageLine}
      hasPage={agent.hasPage}
      masking={agent.masking}
      blocked={agent.blocked}
      pending={agent.pending}
      preApprove={agent.preApprove}
      onPreApproveChange={agent.setPreApprove}
      onApprove={agent.approve}
      onApproveAll={agent.approveAll}
      onDeny={agent.deny}
      onCancel={agent.cancel}
      onDetach={agent.detach}
      isDetached={agent.isDetached}
      onModeChange={agent.setMode}
      onSubmit={agent.runAgent}
      onTaskChange={agent.updateTask}
    />
  )
}
