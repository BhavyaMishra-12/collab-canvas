# Collaborative Canvas

## Overview

Collaborative Canvas is a real-time drawing application where multiple users can draw together on the same canvas. Users can see each other's drawings while they are being made, view live cursor positions, and use a shared undo/redo history.

The project is built using HTML, CSS, JavaScript, and Node.js. Communication between clients is handled using WebSockets without any external libraries.

---

## Live Demo

**Deployed Application:**

https://collab-canvas-l6qc.onrender.com/

> **Note:** Since the application is hosted on Render's free tier, the server may take around 30–60 seconds to wake up if it has been idle. :contentReference[oaicite:0]{index=0}

---

## Features

- Real-time collaborative drawing
- Live cursor updates
- Shared canvas for multiple users
- Global undo and redo
- Multiple drawing rooms
- Automatic reconnection if the connection is lost
- Presence panel showing connected users

---

## Technologies Used

- HTML5
- CSS3
- Vanilla JavaScript
- Node.js
- HTML5 Canvas API
- Custom WebSocket implementation

---

## Project Structure

```
client/
    index.html
    style.css
    canvas.js
    websocket.js
    main.js

server/
    server.js
    rooms.js
    drawing-state.js
    ws-lite.js

test/
    test-client.js
```

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/BhavyaMishra-12/collab-canvas.git
```

### 2. Move into the project folder

```bash
cd collab-canvas
```

### 3. Install dependencies

```bash
npm install
```

### 4. Start the server

```bash
npm start
```

Open the application in your browser:

```
http://localhost:3000
```

---

## Testing the Application

### Real-Time Collaboration

1. Open the application in two different browser windows.
2. Start drawing in one window.
3. The drawing should appear instantly in the other window.

### Testing Multiple Rooms

Different rooms can be created using query parameters.

Example:

```
https://collab-canvas-l6qc.onrender.com/?room=team1
```

Users connected to different room names will have separate drawing boards.

### Integration Test

Start the server:

```bash
npm start
```

Open another terminal:

```bash
node test/test-client.js
```

---

## Current Limitations

- Canvas data is stored in memory only.
- Drawings are lost after restarting the server.
- No user authentication.
- Undo/Redo is shared among all users.
- Single server instance only.
- No zoom or pan support.

---

## Future Improvements

- User authentication
- Save drawings to a database
- Private drawing rooms
- Export canvas as image
- Better mobile support
- Zoom and pan functionality

---

## Author

**Bhavya Mishra**
