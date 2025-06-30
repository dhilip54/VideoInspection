import React, { useState } from 'react';
import Room from './Room';
import './App.css';

function App() {
  const [screen, setScreen] = useState('home');
  const [roomId, setRoomId] = useState('');

  const handleCreate = async () => {
    const res = await fetch('http://18.204.144.126:8084/create-room', { method: 'POST' });
    const data = await res.json();
    setRoomId(data.roomId);
    setScreen('room');
  };

  const handleJoin = async () => {
    if (!roomId) return;
    const res = await fetch('http://18.204.144.126:8084/validate-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId })
    });
    const data = await res.json();
    if (data.valid) {
      setScreen('room');
    } else {
      alert('Room not found');
    }
  };

  if (screen === 'room') {
    return <Room roomId={roomId} />;
  }

  return (
    <div className="app-container">
      <h1>Video Communication App</h1>
      <button onClick={handleCreate}>Create Room</button>
      <div>
        <input
          type="text"
          placeholder="Enter Room ID"
          value={roomId}
          onChange={e => setRoomId(e.target.value)}
        />
        <button onClick={handleJoin}>Join Room</button>
      </div>
    </div>
  );
}

export default App;
