# NetraShield: run it on another computer

You need: **Chrome 116+**, **Python 3.11+**, and (only if you change the code) **Node 20+**.

## 1. Unzip
Unzip `netrashield.zip` anywhere, e.g. `C:\netrashield`. Open a terminal in the
`Browser-s-Agent-main` folder.

## 2. Add your API key
```
copy .env.example .env
```
Open `.env` and set your own key:
- `GEMINI_API_KEY=` your Gemini key (free at https://aistudio.google.com/apikey)
- Blank out the placeholder lines you are not using (`OPENROUTER_API_KEYS=`, `GROQ_API_KEY=`),
  or put real keys there. For faster replies add a Groq key and set `LLM_PROVIDER=groq,gemini`.

The zip deliberately contains **no** `.env` -- never share yours, it holds your key.

## 3. Start the server
```
python -m pip install -r server/requirements.txt
python -m uvicorn server.main:app --host 127.0.0.1 --port 8787
```
Leave this window open. Check http://127.0.0.1:8787/cockpit opens.

## 4. Load the extension
1. Chrome -> `chrome://extensions` -> turn on **Developer mode**.
2. **Load unpacked** -> select the `dist` folder inside `Browser-s-Agent-main`.
3. Pin NetraShield from the puzzle-piece menu.

## 5. Point the extension at your local server
On the NetraShield card click **service worker** (or open the NetraShield popup,
right-click -> Inspect), go to **Console**, paste and press Enter:
```
chrome.storage.local.set({agentServerUrl: 'ws://127.0.0.1:8787/ws/agent'})
```
Then press the reload button on the NetraShield card.

## 6. Use it
Open the site you want (e.g. web.whatsapp.com, signed in), refresh it, open
NetraShield and type a command. The cockpit's `browser:` pill turns green when
the extension is connected.

## Changed the code?
Rebuild the extension, then reload it in Chrome:
```
npm install
npm run build
```
