import 'antd/dist/reset.css'
import { ConfigProvider, theme } from 'antd'
import { PopupPage } from '../pages/popup/PopupPage'
import './styles.css'

export function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          borderRadius: 8,
          colorPrimary: '#a9c4ff',
          colorText: '#f7f3ec',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <PopupPage />
    </ConfigProvider>
  )
}
