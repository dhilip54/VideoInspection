import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import html2canvas from 'html2canvas';

const SIGNAL_SERVER = 'http://18.204.144.126:8084';

function Room({ roomId }) {
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({}); // userId -> MediaStream
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [error, setError] = useState('');
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(true);
  const localVideoRef = useRef();
  const socketRef = useRef();
  const peersRef = useRef({}); // userId -> RTCPeerConnection
  const signalingQueuesRef = useRef({}); // userId -> Promise queue for signaling
  const userId = useRef(uuidv4());
  const localStream = useRef();
  const screenStream = useRef();

  useEffect(() => {
    socketRef.current = io(SIGNAL_SERVER);
    socketRef.current.emit('join', { roomId, userId: userId.current });
    alert(`You joined room: ${roomId} as user: ${userId.current}`);
    socketRef.current.on('participants', (list) => {
      setParticipants(list);
      // Create peer connections to all existing participants (except self)
      list.forEach(existingId => {
        alert(`Existing participant: ${existingId}`);
        if (existingId !== userId.current && !peersRef.current[existingId]) {
          const peer = createPeer(existingId, true);
          peersRef.current[existingId] = peer;
        }
      });
    });
    socketRef.current.on('signal', handleSignal);
    socketRef.current.on('error', setError);
    socketRef.current.on('new-user', ({ userId: newUserId }) => {
      // All existing users create a peer connection to the new user
      if (newUserId !== userId.current && !peersRef.current[newUserId]) {
        const peer = createPeer(newUserId, true);
        peersRef.current[newUserId] = peer;
      }
    });
    return () => {
      socketRef.current.emit('leave', { roomId, userId: userId.current });
      socketRef.current.disconnect();
      Object.values(peersRef.current).forEach(peer => peer.close());
    };
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (!roomId) return;
    setShowPermissionPrompt(true);
    // Do not call startLocalStream here!
    // Request camera/mic permissions and start local stream only when joining a new meeting
    // eslint-disable-next-line
  }, [roomId]);

  const handleAllowPermissions = async () => {
    setShowPermissionPrompt(false);
    await startLocalStream();
  };

  const startLocalStream = async () => {
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      setError('Could not access camera/mic');
    }
  };

  // Handle new user: create a peer connection for them
  const handleNewUser = async ({ userId: newUserId }) => {
    if (newUserId === userId.current) return;
    if (!peersRef.current[newUserId]) {
      const peer = createPeer(newUserId, true);
      peersRef.current[newUserId] = peer;
    }
  };

  // Helper to determine if we are polite (lexicographically greater userId)
  const isPolite = (otherUserId) => userId.current > otherUserId;

  // Create peer connection for a user
  const createPeer = (otherUserId, initiator) => {
    const peer = new window.RTCPeerConnection();
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => peer.addTrack(track, localStream.current));
    }
    peer.ontrack = (e) => {
      setRemoteStreams(prev => ({
        ...prev,
        [otherUserId]: e.streams[0]
      }));
    };
    peer.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit('signal', { roomId, userId: userId.current, to: otherUserId, signal: { candidate: e.candidate } });
      }
    };
    if (initiator) {
      // Initialize signaling queue for this peer
      signalingQueuesRef.current[otherUserId] = Promise.resolve();
      signalingQueuesRef.current[otherUserId] = signalingQueuesRef.current[otherUserId].then(async () => {
        console.log(`[createPeer] Creating offer for ${otherUserId}`);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socketRef.current.emit('signal', { roomId, userId: userId.current, to: otherUserId, signal: { sdp: offer } });
      });
    }
    return peer;
  };

  // Handle incoming signal with polite peer logic
  const handleSignal = async ({ userId: from, signal }) => {
    if (from === userId.current) return;
    let peer = peersRef.current[from];
    if (!peer) {
      peer = createPeer(from, false);
      peersRef.current[from] = peer;
    }
    // Initialize signaling queue for this peer if not present
    if (!signalingQueuesRef.current[from]) {
      signalingQueuesRef.current[from] = Promise.resolve();
    }
    // Queue signaling operations to serialize them
    signalingQueuesRef.current[from] = signalingQueuesRef.current[from].then(async () => {
      try {
        if (signal.sdp) {
          const desc = new RTCSessionDescription(signal.sdp);
          const isOffer = desc.type === 'offer';
          const polite = isPolite(from);

          console.log(`[handleSignal] Received ${desc.type} from ${from}, signalingState: ${peer.signalingState}`);

          if (isOffer) {
            if (peer.signalingState !== 'stable') {
              if (!polite) {
                console.log(`[handleSignal] Ignoring glare offer from impolite peer ${from}`);
                return;
              }
              console.log(`[handleSignal] Rolling back for polite peer ${from}`);
              await peer.setLocalDescription({ type: 'rollback' });
            }
            await peer.setRemoteDescription(desc);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socketRef.current.emit('signal', { roomId, userId: userId.current, to: from, signal: { sdp: answer } });
          } else {
            await peer.setRemoteDescription(desc);
          }
        } else if (signal.candidate) {
          try {
            await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch (err) {
            // Ignore ICE candidate errors
          }
        }
      } catch (err) {
        console.error(`[handleSignal] Error handling signal from ${from}:`, err);
      }
    });
  };

  const toggleMic = () => {
    localStream.current.getAudioTracks().forEach(track => (track.enabled = !micOn));
    setMicOn(!micOn);
  };

  const toggleCam = () => {
    localStream.current.getVideoTracks().forEach(track => (track.enabled = !camOn));
    setCamOn(!camOn);
  };

  const leaveRoom = () => {
    socketRef.current.emit('leave', { roomId, userId: userId.current });
    window.location.reload();
  };

  const startScreenShare = async () => {
    try {
      screenStream.current = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.current.getVideoTracks()[0];
      const sender = peerRef.current.getSenders().find(s => s.track.kind === 'video');
      sender.replaceTrack(screenTrack);
      setScreenSharing(true);
      screenTrack.onended = () => {
        sender.replaceTrack(localStream.current.getVideoTracks()[0]);
        setScreenSharing(false);
      };
    } catch (e) {
      setError('Screen sharing failed');
    }
  };

  const takeScreenshot = async () => {
    if (!localVideoRef.current) return;
    const canvas = await html2canvas(localVideoRef.current);
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = 'screenshot.png';
    link.click();
  };

  // Helper for initials
  const getInitials = name =>
    name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase();

  // Responsive grid columns
  const getGridColumns = () => {
    const count = participantGrid.length;
    if (count === 1) return '1fr';
    if (count === 2) return 'repeat(2, 1fr)';
    if (count <= 4) return 'repeat(2, 1fr)';
    if (count <= 6) return 'repeat(3, 1fr)';
    if (count <= 9) return 'repeat(3, 1fr)';
    return 'repeat(4, 1fr)';
  };

  // Compose participant list for grid (local + remote)
  const participantGrid = [
    {
      id: userId.current,
      name: 'You',
      cameraOn: camOn && localStream.current,
      isLocal: true,
      avatarUrl: null,
      stream: localStream.current,
    },
    ...participants
      .filter(p => p !== userId.current && typeof p === 'string')
      .map(name => ({
        id: name,
        name,
        cameraOn: !!remoteStreams[name],
        isLocal: false,
        avatarUrl: null,
        stream: remoteStreams[name] || null,
      })),
  ];

  // Generate consistent colors for avatars
  const getAvatarColor = (name) => {
    const colors = [
      '#6264A7', '#8378DE', '#8B5A9C', '#AF6B82', '#C4516D',
      '#E54B4B', '#FF8C00', '#FFB900', '#107C10', '#00BCF2'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  // Render participant tile
  const renderParticipant = (user, idx) => (
    <div
      key={user.id || user.name || idx}
      style={{
        background: '#000',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: participantGrid.length === 1 ? 560 : 280,
        minHeight: participantGrid.length === 1 ? 420 : 210,
        width: '100%',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: user.isLocal 
          ? '0 0 0 3px #0078d4' 
          : '0 4px 12px rgba(0, 0, 0, 0.4)',
        transition: 'all 0.2s ease',
      }}
    >
      {/* Show video if camera is on and stream is available */}
      {user.cameraOn && user.stream && (
        <video
          ref={el => {
            if (el && user.stream) {
              el.srcObject = user.stream;
              if (user.isLocal) localVideoRef.current = el;
            }
          }}
          autoPlay
          muted={user.isLocal}
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 12,
          }}
        />
      )}
      
      {/* If camera is off or no stream, show avatar */}
      {(!user.cameraOn || !user.stream) && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: '#2B2B2B',
          borderRadius: 12,
          width: '100%',
        }}>
          <div
            style={{
              width: participantGrid.length === 1 ? 100 : 60,
              height: participantGrid.length === 1 ? 100 : 60,
              borderRadius: '50%',
              marginBottom: 16,
              background: getAvatarColor(user.name || ''),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: participantGrid.length === 1 ? 32 : 20,
              fontWeight: 600,
              color: '#ffffff',
            }}
          >
            {getInitials(user.name || '')}
          </div>
          <div style={{
            fontSize: 14,
            color: '#B3B3B3',
            textAlign: 'center',
            fontWeight: 500,
          }}>
            Camera is off
          </div>
        </div>
      )}
      
      {/* Status indicators - Top right */}
      <div style={{
        position: 'absolute',
        top: 12,
        right: 12,
        display: 'flex',
        gap: 6,
      }}>
        {user.isLocal && !micOn && (
          <div style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(255, 255, 255, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(10px)',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#FF4444">
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
            </svg>
          </div>
        )}
      </div>

      {/* Name label - Bottom left */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          background: 'rgba(0, 0, 0, 0.7)',
          color: '#ffffff',
          padding: '6px 12px',
          borderRadius: 20,
          fontSize: 14,
          fontWeight: 600,
          backdropFilter: 'blur(10px)',
        }}
      >
        {user.name}
      </div>
    </div>
  );

  useEffect(() => {
    if (!localStream.current) return;
    // For each peer, add tracks if not already present and renegotiate
    Object.entries(peersRef.current).forEach(([peerId, peer]) => {
      // Add tracks if not already present
      const senders = peer.getSenders();
      localStream.current.getTracks().forEach(track => {
        if (!senders.find(sender => sender.track && sender.track.kind === track.kind)) {
          peer.addTrack(track, localStream.current);
        }
      });
      // Renegotiate (create and send new offer) only if signalingState is stable and no ongoing signaling
      if (peer.signalingState === 'stable' && (!signalingQueuesRef.current[peerId] || signalingQueuesRef.current[peerId] === Promise.resolve())) {
        signalingQueuesRef.current[peerId] = (async () => {
          console.log(`[renegotiation] Creating offer for ${peerId}`);
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socketRef.current.emit('signal', { roomId, userId: userId.current, to: peerId, signal: { sdp: offer } });
        })();
      }
    });
  }, [localStream.current]);

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      {/* Permission Modal */}
      {showPermissionPrompt && (
        <div style={{
          position: 'fixed', 
          top: 0, 
          left: 0, 
          width: '100vw', 
          height: '100vh',
          background: 'rgba(0, 0, 0, 0.85)', 
          zIndex: 1000, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          backdropFilter: 'blur(20px)',
        }}>
          <div style={{
            background: 'rgba(255, 255, 255, 0.95)', 
            borderRadius: 20, 
            padding: 40, 
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)', 
            maxWidth: 420, 
            textAlign: 'center',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
          }}>
            <div style={{ 
              width: 80,
              height: 80,
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
            </div>
            <h2 style={{ 
              margin: '0 0 16px 0', 
              color: '#2c3e50', 
              fontSize: 28, 
              fontWeight: 700,
              letterSpacing: '-0.5px',
            }}>
              Ready to join?
            </h2>
            <p style={{ 
              margin: '0 0 32px 0', 
              color: '#5a6c7d', 
              lineHeight: 1.6, 
              fontSize: 16,
              fontWeight: 400,
            }}>
              We'll need access to your camera and microphone to get started
            </p>
            <button 
              onClick={handleAllowPermissions} 
              style={{ 
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: 25,
                fontSize: 16, 
                fontWeight: 600,
                padding: '16px 32px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: '0 8px 20px rgba(102, 126, 234, 0.3)',
                minWidth: 140,
              }}
              onMouseOver={(e) => {
                e.target.style.transform = 'translateY(-2px)';
                e.target.style.boxShadow = '0 12px 30px rgba(102, 126, 234, 0.4)';
              }}
              onMouseOut={(e) => {
                e.target.style.transform = 'translateY(0)';
                e.target.style.boxShadow = '0 8px 20px rgba(102, 126, 234, 0.3)';
              }}
            >
              Join Meeting
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.05)',
        backdropFilter: 'blur(20px)',
        padding: '20px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ 
            width: 40, 
            height: 40, 
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', 
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
          </div>
          <div>
            <h1 style={{ margin: 0, color: '#ffffff', fontSize: 20, fontWeight: 700 }}>
              Meeting Room
            </h1>
            <p style={{ margin: 0, color: 'rgba(255, 255, 255, 0.7)', fontSize: 14 }}>
              {roomId.length > 25 ? `${roomId.substring(0, 25)}...` : roomId}
            </p>
          </div>
        </div>
        <div style={{ 
          color: '#ffffff', 
          fontSize: 16,
          fontWeight: 600,
          background: 'rgba(255, 255, 255, 0.1)',
          padding: '8px 16px',
          borderRadius: 20,
          backdropFilter: 'blur(10px)',
        }}>
          {participantGrid.length} {participantGrid.length === 1 ? 'participant' : 'participants'}
        </div>
      </div>

      {/* Main content area */}
      <div style={{ flex: 1, padding: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Video grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: getGridColumns(),
            gap: 24,
            alignItems: 'center',
            justifyItems: 'center',
            maxWidth: 1400,
            width: '100%',
          }}
        >
          {participantGrid.length === 0 && (
            <div style={{ 
              color: 'rgba(255, 255, 255, 0.8)', 
              textAlign: 'center', 
              gridColumn: '1/-1',
              fontSize: 18,
              fontWeight: 500,
            }}>
              Waiting for participants to join...
            </div>
          )}
          {participantGrid.map(renderParticipant)}
        </div>
      </div>

      {/* Controls bar */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.05)',
        backdropFilter: 'blur(20px)',
        padding: '24px 32px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
        borderTop: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        <button 
          onClick={toggleMic}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: 'none',
            background: micOn 
              ? 'rgba(255, 255, 255, 0.15)' 
              : 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            backdropFilter: 'blur(10px)',
            boxShadow: micOn 
              ? '0 4px 12px rgba(255, 255, 255, 0.1)' 
              : '0 4px 12px rgba(255, 71, 87, 0.3)',
          }}
          onMouseOver={(e) => {
            e.target.style.transform = 'translateY(-2px)';
            e.target.style.background = micOn 
              ? 'rgba(255, 255, 255, 0.25)' 
              : 'linear-gradient(135deg, #ff3838 0%, #ff2929 100%)';
          }}
          onMouseOut={(e) => {
            e.target.style.transform = 'translateY(0)';
            e.target.style.background = micOn 
              ? 'rgba(255, 255, 255, 0.15)' 
              : 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)';
          }}
          title={micOn ? 'Mute microphone' : 'Unmute microphone'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            {micOn ? (
              <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
            ) : (
              <>
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
              </>
            )}
          </svg>
        </button>

        <button 
          onClick={toggleCam}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: 'none',
            background: camOn 
              ? 'rgba(255, 255, 255, 0.15)' 
              : 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            backdropFilter: 'blur(10px)',
            boxShadow: camOn 
              ? '0 4px 12px rgba(255, 255, 255, 0.1)' 
              : '0 4px 12px rgba(255, 71, 87, 0.3)',
          }}
          onMouseOver={(e) => {
            e.target.style.transform = 'translateY(-2px)';
            e.target.style.background = camOn 
              ? 'rgba(255, 255, 255, 0.25)' 
              : 'linear-gradient(135deg, #ff3838 0%, #ff2929 100%)';
          }}
          onMouseOut={(e) => {
            e.target.style.transform = 'translateY(0)';
            e.target.style.background = camOn 
              ? 'rgba(255, 255, 255, 0.15)' 
              : 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)';
          }}
          title={camOn ? 'Turn off camera' : 'Turn on camera'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            {camOn ? (
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            ) : (
              <>
                <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
              </>
            )}
          </svg>
        </button>

        <button 
          onClick={startScreenShare}
          disabled={screenSharing}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: 'none',
            background: screenSharing 
              ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' 
              : 'rgba(255, 255, 255, 0.15)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: screenSharing ? 'default' : 'pointer',
            transition: 'all 0.3s ease',
            backdropFilter: 'blur(10px)',
            boxShadow: screenSharing 
              ? '0 4px 12px rgba(102, 126, 234, 0.3)' 
              : '0 4px 12px rgba(255, 255, 255, 0.1)',
            opacity: screenSharing ? 1 : 0.9,
          }}
          onMouseOver={(e) => {
            if (!screenSharing) {
              e.target.style.transform = 'translateY(-2px)';
              e.target.style.background = 'rgba(255, 255, 255, 0.25)';
            }
          }}
          onMouseOut={(e) => {
            if (!screenSharing) {
              e.target.style.transform = 'translateY(0)';
              e.target.style.background = 'rgba(255, 255, 255, 0.15)';
            }
          }}
          title="Share screen"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
            {screenSharing && <circle cx="12" cy="11" r="2" fill="currentColor"/>}
          </svg>
        </button>

        <button 
          onClick={takeScreenshot}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(255, 255, 255, 0.15)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 12px rgba(255, 255, 255, 0.1)',
          }}
          onMouseOver={(e) => {
            e.target.style.transform = 'translateY(-2px)';
            e.target.style.background = 'rgba(255, 255, 255, 0.25)';
          }}
          onMouseOut={(e) => {
            e.target.style.transform = 'translateY(0)';
            e.target.style.background = 'rgba(255, 255, 255, 0.15)';
          }}
          title="Take screenshot"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="3.2"/>
            <path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/>
          </svg>
        </button>

        <div style={{ 
          width: 2, 
          height: 40, 
          background: 'rgba(255, 255, 255, 0.2)', 
          margin: '0 12px',
          borderRadius: 1,
        }} />

        <button 
          onClick={leaveRoom}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: 'none',
            background: 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            boxShadow: '0 4px 12px rgba(255, 71, 87, 0.3)',
          }}
          onMouseOver={(e) => {
            e.target.style.transform = 'translateY(-2px)';
            e.target.style.background = 'linear-gradient(135deg, #ff3838 0%, #ff2929 100%)';
            e.target.style.boxShadow = '0 6px 16px rgba(255, 71, 87, 0.4)';
          }}
          onMouseOut={(e) => {
            e.target.style.transform = 'translateY(0)';
            e.target.style.background = 'linear-gradient(135deg, #ff4757 0%, #ff3838 100%)';
            e.target.style.boxShadow = '0 4px 12px rgba(255, 71, 87, 0.3)';
          }}
          title="Leave meeting"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h6v-2H6V4h6V2H6zm10.5 11l-2.5 2.5 1.5 1.5L20 12l-4.5-5-1.5 1.5L16.5 11H9v2h7.5z"/>
          </svg>
        </button>
      </div>

      {/* Error notification */}
      {error && (
        <div style={{
          position: 'fixed',
          top: 100,
          right: 32,
          background: 'rgba(255, 71, 87, 0.95)',
          color: '#ffffff',
          padding: '16px 20px',
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 600,
          boxShadow: '0 8px 24px rgba(255, 71, 87, 0.3)',
          zIndex: 1000,
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          animation: 'slideInRight 0.3s ease',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            {error}
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export default Room;