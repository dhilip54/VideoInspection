// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// In-memory room store
const rooms = {};

// REST endpoint to create a room
app.post('/create-room', (req, res) => {
  const roomId = uuidv4();
  rooms[roomId] = { participants: [] };
  res.json({ roomId });
});

// REST endpoint to validate a room
app.post('/validate-room', (req, res) => {
  const { roomId } = req.body;
  if (rooms[roomId]) {
    res.json({ valid: true });
  } else {
    res.json({ valid: false });
  }
});

// Socket.IO signaling
io.on('connection', (socket) => {
  socket.on('join', ({ roomId, userId }) => {
    if (!rooms[roomId]) return socket.emit('error', 'Room not found');
    rooms[roomId].participants.push({ id: userId, socketId: socket.id });
    socket.join(roomId);
    io.to(roomId).emit('participants', rooms[roomId].participants.map(p => p.id));
  });

  socket.on('signal', ({ roomId, userId, signal }) => {
    socket.to(roomId).emit('signal', { userId, signal });
  });

  socket.on('leave', ({ roomId, userId }) => {
    if (rooms[roomId]) {
      rooms[roomId].participants = rooms[roomId].participants.filter(p => p.id !== userId);
      socket.leave(roomId);
      io.to(roomId).emit('participants', rooms[roomId].participants.map(p => p.id));
      if (rooms[roomId].participants.length === 0) {
        delete rooms[roomId];
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.participants.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.participants.splice(idx, 1);
        io.to(roomId).emit('participants', room.participants.map(p => p.id));
        if (room.participants.length === 0) {
          delete rooms[roomId];
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
