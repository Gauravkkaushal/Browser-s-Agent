import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(__dirname, 'build-onnx-model.py')

const result = spawnSync('python', [scriptPath], { stdio: 'inherit' })
if (result.status !== 0) {
  console.error('Failed to build ONNX model with python script.')
  process.exit(result.status || 1)
}
