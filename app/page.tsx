"use client";

import { useEffect, useState, useRef } from "react";

interface User {
  client_id: string;
  name: string;
}

export default function HomePage() {
  const [clientId, setClientId] = useState<string>("");
  const [users, setUsers] = useState<User[]>([]);
  const [incoming, setIncoming] = useState<any>(null);
  const [currentPeer, setCurrentPeer] = useState<string | null>(null);
  const [currentPeerName, setCurrentPeerName] = useState<string>("");
  const [micStatus, setMicStatus] = useState<"active" | "muted" | "broken">("muted");
  const [callStatus, setCallStatus] = useState<"idle" | "calling" | "connected">("idle");
  const [speaking, setSpeaking] = useState<Record<string, number>>({});
  const [testMicOn, setTestMicOn] = useState(false);
  // mic
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const iceQueueRef = useRef<any[]>([]);

  useEffect(() => {
    let id = localStorage.getItem("clientId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("clientId", id);
    }
    setClientId(id);
    console.log("🔹 Client ID:", id);
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(async stream => {
        // localStreamRef.current = stream;
        // setMicStatus("active");
        localStreamRef.current = stream;
        setMicStatus("active");

        // 🎤 AMBIL LIST MIC SETELAH PERMISSION
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === "audioinput");
        setAudioDevices(mics);
        if (mics.length > 0) setSelectedMic(mics[0].deviceId);

        console.log("🎤 Mic ready:", stream.getTracks());
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const animateMic = () => {
          analyser.getByteFrequencyData(dataArray);
          let sumSquares = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = dataArray[i] / 255;
            sumSquares += val * val;
          }
          const rms = Math.sqrt(sumSquares / dataArray.length);
          const volume = Math.min(100, rms * 200);
          setSpeaking(prev => ({ ...prev, [id!]: volume }));
          animationFrameRef.current = requestAnimationFrame(animateMic);
        };
        animateMic();
      })
      .catch(err => {
        console.error("❌ Mic error:", err);
        setMicStatus("broken");
        alert("Microphone tidak tersedia atau izin ditolak.");
      });

    const ws = new WebSocket("wss://ws-voicertc-production.up.railway.app");
    wsRef.current = ws;
    ws.onopen = () => {
      console.log("✅ WS connected");
      ws.send(JSON.stringify({ type: "join", client_id: id, name: "User-" + id.slice(0, 4) }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      console.log("📨 WS message:", msg);

      switch (msg.type) {
        case "user-list":
          setUsers(msg.users.filter((u: User) => u.client_id !== id));
          break;
        case "call":
          console.log("📞 Incoming call:", msg.from);
          setIncoming(msg);
          break;
        case "call-accept":
          console.log("✅ Call accepted by:", msg.from);
          startWebRTC(msg.from, false);
          setCurrentPeer(msg.from);
          setCurrentPeerName(msg.name || "Unknown");
          setCallStatus("connected");
          break;
        case "call-rejected":
          alert("Panggilan ditolak");
          hangupCall(false);
          break;
        case "offer":
          handleOffer(msg.offer, msg.from);
          break;
        case "answer":
          handleAnswer(msg.answer);
          break;
        case "ice":
          handleIce(msg.candidate);
          break;
        case "call-ended":
          alert("Panggilan berakhir");
          hangupCall(false);
          break;
      }
    };

    ws.onerror = (e) => console.error("⚠️ WS error:", e);
    ws.onclose = () => console.log("❌ WS closed");

    return () => {
      ws.close();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  function callUser(to: string) {
    if (callStatus !== "idle") return;
    console.log("📞 Calling:", to);
    const user = users.find(u => u.client_id === to);
    startWebRTC(to, true);
    wsRef.current?.send(JSON.stringify({ type: "call", from: clientId, to }));
    setCurrentPeer(to);
    setCurrentPeerName(user?.name || "Unknown");
    setCallStatus("calling");
  }

  function acceptCall(from: string) {
    startWebRTC(from, false);
    wsRef.current?.send(JSON.stringify({ type: "call-accept", from: clientId, to: from }));
    setCurrentPeer(from);
    setCurrentPeerName(incoming?.name || "Unknown");
    setCallStatus("connected");
    setIncoming(null);
    setTimeout(forcePlayRemoteAudio, 200);
  }

  function hangupCall(sendSignal = true) {
    if (sendSignal && currentPeer) {
      wsRef.current?.send(JSON.stringify({ type: "hangup", from: clientId, to: currentPeer }));
    }
    pcRef.current?.close();
    pcRef.current = null;
    iceQueueRef.current = [];
    setCurrentPeer(null);
    setCurrentPeerName("");
    setCallStatus("idle");
  }

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicStatus(track.enabled ? "active" : "muted");
  }
  async function changeMic(deviceId: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    const newTrack = stream.getAudioTracks()[0];
    if (pcRef.current) {
      const sender = pcRef.current
        .getSenders()
        .find(s => s.track?.kind === "audio");
      sender?.replaceTrack(newTrack);
    }

    // STOP MIC LAMA
    localStreamRef.current?.getTracks().forEach(t => t.stop());

    localStreamRef.current = stream;
    setSelectedMic(deviceId);
    setMicStatus("active");
  }

  function toggleTestMic() {
    if (!localStreamRef.current) return alert("Mic tidak tersedia");
    if (!testMicOn) {
      if (!testAudioRef.current) {
        testAudioRef.current = document.createElement("audio");
        testAudioRef.current.autoplay = true;
        testAudioRef.current.srcObject = localStreamRef.current;
      }
      testAudioRef.current.play().catch(() => { });
      setTestMicOn(true);
    } else {
      testAudioRef.current?.pause();
      setTestMicOn(false);
    }
  }

  function forcePlayRemoteAudio() {
    if (!remoteAudioRef.current) return;
    remoteAudioRef.current.muted = false;
    remoteAudioRef.current.volume = 1;
    remoteAudioRef.current.play().catch(() => setTimeout(forcePlayRemoteAudio, 200));
  }

  async function startWebRTC(peerId: string, initiator: boolean) {
    if (pcRef.current) return;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;
    localStreamRef.current?.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));

    pc.onicecandidate = e => {
      if (e.candidate) wsRef.current?.send(JSON.stringify({ type: "ice", from: clientId, to: peerId, candidate: e.candidate }));
    };
    pc.ontrack = e => {
      const [stream] = e.streams;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
      trackRemoteVolume(stream);
    };
    pc.oniceconnectionstatechange = () => console.log("ICE state:", pc.iceConnectionState);
    if (initiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      wsRef.current?.send(JSON.stringify({ type: "offer", from: clientId, to: peerId, offer }));
    }

    async function trackRemoteVolume(stream: MediaStream) {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const animate = () => {
        analyser.getByteFrequencyData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) sumSquares += (dataArray[i] / 255) ** 2;
        const volume = Math.sqrt(sumSquares / dataArray.length) * 100;
        console.log("Remote volume:", volume.toFixed(2));
        requestAnimationFrame(animate);
      };
      animate();
    }
  }

  async function handleOffer(offer: any, from: string) {
    await startWebRTC(from, false);
    if (!pcRef.current) return;
    await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
    iceQueueRef.current.forEach(c => pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn));
    iceQueueRef.current = [];
    const answer = await pcRef.current.createAnswer({ offerToReceiveAudio: true });
    await pcRef.current.setLocalDescription(answer);
    wsRef.current?.send(JSON.stringify({ type: "answer", from: clientId, to: from, answer }));
  }

  async function handleAnswer(answer: any) {
    if (!pcRef.current) return;
    await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
    iceQueueRef.current.forEach(c => pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn));
    iceQueueRef.current = [];
  }

  async function handleIce(candidate: any) {
    if (!pcRef.current || !pcRef.current.remoteDescription) {
      iceQueueRef.current.push(candidate);
    } else {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  return (
    <div className="min-h-screen bg-[#202124] relative overflow-hidden">
      {/* Subtle Background Pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgb(255 255 255 / 0.15) 1px, transparent 0)',
          backgroundSize: '40px 40px'
        }}></div>
      </div>

      {/* Main Container */}
      <div className="relative z-10 flex flex-col h-screen">
        {/* Header */}
        <header className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 bg-[#1a1a1c] border-b border-white/5">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-lg">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <div>
                <h1 className="text-white font-medium text-base sm:text-lg">Voice Meet</h1>
                <p className="text-white/50 text-[10px] sm:text-xs font-mono hidden sm:block">ID: {clientId.slice(0, 8)}</p>
              </div>
            </div>
          </div>

          {/* Status Indicator */}
          <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-white/5 border border-white/10">
            <div className={`w-2 h-2 rounded-full ${micStatus === "active" ? "bg-green-400 animate-pulse" :
              micStatus === "muted" ? "bg-gray-400" : "bg-red-400"
              }`}></div>
            <span className="text-white/70 text-xs sm:text-sm">
              {micStatus === "active" ? "Connected" : micStatus === "muted" ? "Muted" : "Error"}
            </span>
          </div>
        </header>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col lg:flex-row">
          {/* Center Stage - Call View */}
          <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">
            {callStatus === "connected" && (
              <div className="w-full max-w-3xl px-4">
                {/* Active Call Card */}
                <div className="bg-[#2d2e30] rounded-3xl shadow-2xl p-6 sm:p-8 border border-white/10">
                  <div className="flex flex-col items-center text-center mb-6 sm:mb-8">
                    <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-4xl sm:text-5xl font-bold mb-4 shadow-2xl ring-4 ring-blue-500/20">
                      {currentPeerName?.[0]?.toUpperCase() || "U"}
                    </div>
                    <h2 className="text-white text-2xl sm:text-3xl font-semibold mb-2">{currentPeerName}</h2>
                    <div className="flex items-center gap-2 text-green-400">
                      <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
                      <span className="text-sm font-medium">Connected</span>
                    </div>
                  </div>

                  {/* Call Controls */}
                  <div className="flex items-center justify-center gap-3 sm:gap-4 flex-wrap">
                    <button
                      onClick={toggleMic}
                      disabled={micStatus === "broken"}
                      className={`group relative w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 ${micStatus === "active"
                        ? "bg-white/10 hover:bg-white/15"
                        : "bg-red-500 hover:bg-red-600"
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      title={micStatus === "active" ? "Mute microphone" : "Unmute microphone"}
                    >
                      {micStatus === "active" ? (
                        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                      ) : (
                        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => hangupCall()}
                      className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-105"
                      title="End call"
                    >
                      <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                      </svg>
                    </button>

                    <button
                      onClick={forcePlayRemoteAudio}
                      className="w-14 h-14 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center transition-all duration-200"
                      title="Test audio"
                    >
                      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                      </svg>
                    </button>
                  </div>

                  {/* Audio Level Indicator */}
                  <div className="mt-6 flex items-center gap-3">
                    <svg className="w-5 h-5 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-400 to-green-500 transition-all duration-100 rounded-full"
                        style={{ width: `${speaking[clientId] || 0}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {callStatus === "calling" && (
              <div className="w-full max-w-3xl px-4">
                <div className="bg-[#2d2e30] rounded-3xl shadow-2xl p-8 sm:p-12 border border-white/10 text-center">
                  <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-4xl sm:text-5xl font-bold mb-6 mx-auto shadow-2xl ring-4 ring-blue-500/20 animate-pulse">
                    {currentPeerName?.[0]?.toUpperCase() || "U"}
                  </div>
                  <h2 className="text-white text-2xl sm:text-3xl font-semibold mb-2">Calling...</h2>
                  <p className="text-white/60 text-lg sm:text-xl mb-8">{currentPeerName}</p>
                  <button
                    onClick={() => hangupCall()}
                    className="px-8 py-4 rounded-full bg-red-500 hover:bg-red-600 text-white font-medium transition-all duration-200 shadow-lg hover:shadow-xl"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {callStatus === "idle" && (
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6 mx-auto">
                  <svg className="w-12 h-12 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <h2 className="text-white/70 text-xl mb-2">No active call</h2>
                <p className="text-white/40">Select a participant to start calling</p>
              </div>
            )}
          </div>

          {/* Right Sidebar - Participants */}
          <aside className="w-full lg:w-96 bg-[#1a1a1c] border-t lg:border-t-0 lg:border-l border-white/5 flex flex-col max-h-[50vh] lg:max-h-none">
            {/* Sidebar Header */}
            <div className="p-4 sm:p-6 border-b border-white/5">
              <h3 className="text-white font-semibold text-base sm:text-lg mb-1">Participants</h3>
              <p className="text-white/50 text-xs sm:text-sm">{users.length} available</p>
            </div>
            {/* change mic */}
            <div className="mb-3">
              <label className="block text-white/60 text-xs mb-1">
                Microphone
              </label>
              <select
                value={selectedMic}
                onChange={(e) => changeMic(e.target.value)}
                className="w-full bg-[#2d2e30] text-white text-sm px-3 py-2 rounded-lg border border-white/10"
              >
                {audioDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Unknown microphone"}
                  </option>
                ))}
              </select>
            </div>

            {/* Mic Test Section */}
            <div className="p-4 border-b border-white/5 bg-white/5">
              <button
                onClick={toggleTestMic}
                disabled={micStatus === "broken"}
                className="w-full px-4 py-3 rounded-lg bg-white/10 hover:bg-white/15 text-white font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
                {testMicOn ? "Stop Mic Test" : "Test Your Microphone"}
              </button>
            </div>

            {/* Participants List */}
            <div className="flex-1 overflow-y-auto">
              {users.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center p-8">
                  <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                    <svg className="w-8 h-8 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                  </div>
                  <p className="text-white/50 text-sm mb-1">No one else is here</p>
                  <p className="text-white/30 text-xs">Waiting for others to join...</p>
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {users.map((u) => {
                    const isInCall = currentPeer === u.client_id;
                    return (
                      <div
                        key={u.client_id}
                        className={`group rounded-xl p-4 transition-all duration-200 ${isInCall
                          ? "bg-blue-500/20 border border-blue-500/30"
                          : "bg-white/5 hover:bg-white/10 border border-transparent"
                          }`}
                      >
                        <div className="flex items-center gap-3 mb-3">
                          <div className="relative">
                            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                              {u?.name?.[0]?.toUpperCase() || "U"}
                            </div>
                            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-green-400 border-2 border-[#1a1a1c] rounded-full"></div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white font-medium truncate">{u.name}</p>
                            <p className="text-white/40 text-xs font-mono">{u.client_id.slice(0, 8)}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => callUser(u.client_id)}
                          disabled={isInCall || callStatus !== "idle"}
                          className={`w-full px-4 py-2.5 rounded-lg font-medium transition-all duration-200 ${isInCall
                            ? "bg-white/10 text-white/50 cursor-not-allowed"
                            : "bg-blue-500 hover:bg-blue-600 text-white shadow-lg hover:shadow-xl"
                            }`}
                        >
                          {isInCall ? (
                            <span className="flex items-center justify-center gap-2">
                              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                              In Call
                            </span>
                          ) : (
                            <span className="flex items-center justify-center gap-2">
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                              </svg>
                              Call
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {incoming && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-xl flex items-center justify-center z-50 animate-in fade-in duration-200 p-4">
          <div className="bg-[#2d2e30] rounded-3xl shadow-2xl max-w-md w-full p-6 sm:p-10 text-center border border-white/10">
            <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-4xl sm:text-5xl font-bold mb-4 sm:mb-6 mx-auto shadow-2xl ring-4 ring-blue-500/20 animate-bounce">
              {incoming?.name?.[0]?.toUpperCase() || "U"}
            </div>
            <h3 className="text-white text-xl sm:text-2xl font-semibold mb-2">Incoming call</h3>
            <p className="text-white/60 text-base sm:text-lg mb-6 sm:mb-8">{incoming.name}</p>
            <div className="flex gap-3 sm:gap-4">
              <button
                onClick={() => hangupCall()}
                className="flex-1 px-4 sm:px-8 py-3 sm:py-4 rounded-full bg-white/10 hover:bg-white/15 text-white font-medium transition-all duration-200 flex items-center justify-center gap-2 text-sm sm:text-base"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Decline
              </button>
              <button
                onClick={() => acceptCall(incoming.from)}
                className="flex-1 px-4 sm:px-8 py-3 sm:py-4 rounded-full bg-green-500 hover:bg-green-600 text-white font-medium transition-all duration-200 shadow-lg hover:shadow-xl flex items-center justify-center gap-2 text-sm sm:text-base"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}
      <audio ref={remoteAudioRef} autoPlay playsInline muted={false} />
    </div>
  );
}
