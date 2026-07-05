# TURNCOAT — Milestone 1

A 3D multiplayer room. Players join with a 4-letter code, walk around, and see each other move in real time. This is the foundation everything else (roles, hiding, painting, voting) gets built on.

**What's in the box:**
- `server.js` — the game server (rooms, player sync)
- `public/index.html` — the game itself (3D world, controls, lobby)
- `package.json` — tells Node.js what the project needs

---

## Part 1 — Run it on your own computer (15 min)

### Step 1: Install Node.js
1. Go to https://nodejs.org
2. Download the **LTS** version and install it (just click Next through the installer).
3. To check it worked: open **Terminal** (Mac) or **Command Prompt** (Windows) and type `node --version` then press Enter. You should see a version number like `v22.x.x`.

### Step 2: Get the game folder
1. Unzip the `turncoat` folder somewhere easy, like your Desktop.

### Step 3: Install & start
1. In Terminal / Command Prompt, move into the folder. Type `cd ` (with a space), then drag the turncoat folder onto the window, then press Enter.
2. Type `npm install` and press Enter. (Downloads the server libraries — takes ~30 seconds, only needed once.)
3. Type `npm start` and press Enter. You should see: `TURNCOAT server running!`

### Step 4: Play
1. Open your browser and go to **http://localhost:3000**
2. Enter a name and click **Create room**.
3. Open a **second browser tab** to http://localhost:3000, type the 4-letter room code, and click **Join room**. Move around in one tab (WASD keys) — you'll see yourself move in the other. That's multiplayer working!

To stop the server: click on the Terminal window and press `Ctrl + C`.

> Note: `localhost` only works on your own computer. To play with friends, do Part 2.

---

## Part 2 — Put it online so friends can play (30 min, free)

We'll use **GitHub** (stores your code) + **Render** (runs your server). Both free.

### Step 1: Put the code on GitHub
1. Create a free account at https://github.com
2. Click the **+** in the top right → **New repository**. Name it `turncoat`, keep it Public, click **Create repository**.
3. On the new repo page, click **uploading an existing file**.
4. Drag in `server.js`, `package.json`, and `README.md` from your turncoat folder. **Important:** also open the `public` folder question — GitHub's drag-and-drop can't upload folders directly, so do this instead: after the first upload, click **Add file → Create new file**, type `public/index.html` as the filename (the slash creates the folder), then open your local `public/index.html` in a text editor (Notepad/TextEdit), copy everything, paste it in, and click **Commit changes**.

### Step 2: Deploy on Render
1. Create a free account at https://render.com (you can sign up with your GitHub account — do that, it makes the next step easier).
2. Click **New → Web Service**.
3. Connect your GitHub and pick the `turncoat` repository.
4. Fill in:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Click **Deploy**. Wait a few minutes until it says **Live**.
6. Render gives you a link like `https://turncoat.onrender.com` — **that's your game.** Send it to friends, create a room, share the code, play.

### Good to know about the free tier
- The server **falls asleep after ~15 minutes of no visitors**. The first person to open the link wakes it up (takes ~30–60 seconds). Fine for testing; if the game takes off, upgrading to a paid instance fixes it.
- If the server restarts, open rooms are cleared (players just refresh and make a new room).

---

## Updating the game later
When we build Milestone 2, you'll just replace the changed files on GitHub (open the file there → pencil icon → paste new version → Commit). Render redeploys automatically.

## Troubleshooting
- **"npm is not recognized"** → Node.js isn't installed, or you need to close and reopen the Terminal after installing.
- **Nothing at localhost:3000** → make sure the Terminal still shows the server running (`npm start`).
- **Friends see "Room not found"** → the server probably restarted; create a fresh room and share the new code.
- **Render deploy fails** → check that `package.json` was uploaded and the start command is exactly `npm start`.
