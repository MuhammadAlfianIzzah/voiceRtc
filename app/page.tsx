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

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const remoteAnimationFrameRef = useRef<number | null>(null);

  /* ================= INIT ================= */
  useEffect(() => {
    let id = localStorage.getItem("clientId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("clientId", id);
    }
    setClientId(id);

    const ws = new WebSocket("ws://ws-voicertc-production.up.railway.app");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      ws.send(JSON.stringify({ type: "join", client_id: id, name: "User-" + id.slice(0, 4) }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      console.log("WS Message:", msg);

      switch (msg.type) {
        case "user-list":
          setUsers(msg.users.filter((u: User) => u.client_id !== id));
          break;
        case "call":
          setIncoming(msg);
          break;
        case "call-accept":
          console.log("Call accepted, starting WebRTC as initiator");
          startWebRTC(msg.from, true); // Initiator = true!
          setCurrentPeer(msg.from);
          setCurrentPeerName(msg.name || "Unknown");
          setCallStatus("connected");
          break;
        case "call-rejected":
          alert("Panggilan ditolak");
          setCurrentPeer(null);
          setCallStatus("idle");
          break;
        case "offer":
          console.log("Received offer");
          handleOffer(msg.offer, msg.from);
          break;
        case "answer":
          console.log("Received answer");
          handleAnswer(msg.answer);
          break;
        case "ice":
          console.log("Received ICE candidate");
          handleIce(msg.candidate);
          break;
        case "call-ended":
          hangupCall(false);
          alert("Panggilan berakhir");
          break;
      }
    };

    ws.onerror = (err) => console.error("WS Error:", err);
    ws.onclose = () => console.log("WS Closed");

    return () => {
      ws.close();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (remoteAnimationFrameRef.current) cancelAnimationFrame(remoteAnimationFrameRef.current);
    };
  }, []);

  /* ================= CALL CONTROL ================= */
  function callUser(to: string) {
    const user = users.find(u => u.client_id === to);
    console.log("Calling user:", to);
    wsRef.current?.send(JSON.stringify({ type: "call", from: clientId, to }));
    setCurrentPeer(to);
    setCurrentPeerName(user?.name || "Unknown");
    setCallStatus("calling");
  }

  function acceptCall(from: string) {
    console.log("Accepting call from:", from);
    startWebRTC(from, false); // Initiator = false
    wsRef.current?.send(JSON.stringify({ type: "call-accept", from: clientId, to: from }));
    setCurrentPeer(from);
    setCurrentPeerName(incoming?.name || "Unknown");
    setCallStatus("connected");
    setIncoming(null);
  }

  function rejectCall(from: string) {
    wsRef.current?.send(JSON.stringify({ type: "call-reject", from: clientId, to: from }));
    setIncoming(null);
  }

  function hangupCall(sendSignal = true) {
    console.log("Hanging up call");
    if (sendSignal && currentPeer)
      wsRef.current?.send(JSON.stringify({ type: "hangup", from: clientId, to: currentPeer }));

    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setCurrentPeer(null);
    setCurrentPeerName("");
    setMicStatus("muted");
    setCallStatus("idle");

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (remoteAnimationFrameRef.current) {
      cancelAnimationFrame(remoteAnimationFrameRef.current);
      remoteAnimationFrameRef.current = null;
    }
  }

  function toggleMic() {
    if (!localStreamRef.current) return;
    const track = localStreamRef.current.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicStatus(track.enabled ? "active" : "muted");
  }

  // Manual play remote audio
  function forcePlayRemoteAudio() {
    if (remoteAudioRef.current) {
      console.log("Forcing remote audio play...");
      console.log("Remote audio srcObject:", remoteAudioRef.current.srcObject);
      console.log("Remote audio muted:", remoteAudioRef.current.muted);
      console.log("Remote audio volume:", remoteAudioRef.current.volume);
      remoteAudioRef.current.play()
        .then(() => console.log("✅ Forced play successful!"))
        .catch(err => console.error("❌ Forced play failed:", err));
    }
  }

  /* ================= WEBRTC ================= */
  async function startWebRTC(peerId: string, initiator: boolean) {
    if (pcRef.current) {
      console.log("PeerConnection already exists");
      return;
    }

    console.log("Starting WebRTC, initiator:", initiator);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ],
      iceCandidatePoolSize: 10
    });
    pcRef.current = pc;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 48000
        }
      });
      localStreamRef.current = stream;
      setMicStatus("active");
      console.log("Got local stream");

      // Analisis mic sendiri
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const animateMic = () => {
        analyser.getByteFrequencyData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = dataArray[i] / 255;
          sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const volume = Math.min(100, rms * 200);
        setSpeaking((prev) => ({ ...prev, [clientId]: volume }));
        animationFrameRef.current = requestAnimationFrame(animateMic);
      };
      animateMic();

      // Tambahkan track ke peer
      stream.getTracks().forEach((track) => {
        console.log("Adding track:", track.kind);
        pc.addTrack(track, stream);
      });
    } catch (err) {
      console.error("Mic error:", err);
      setMicStatus("broken");
      alert("Microphone tidak terdeteksi atau izin ditolak.");
      hangupCall();
      return;
    }

    // ICE
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log("Sending ICE candidate");
        wsRef.current?.send(JSON.stringify({
          type: "ice",
          from: clientId,
          to: peerId,
          candidate: e.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        alert("Koneksi terputus");
        hangupCall();
      }
    };

    // Track dari lawan
    pc.ontrack = (e) => {
      console.log("Received remote track:", e.track.kind, e.streams.length);
      if (e.streams[0]) {
        const remoteStream = e.streams[0];
        console.log("Remote stream tracks:", remoteStream.getTracks().map(t => t.kind));

        if (remoteAudioRef.current) {
          // Set srcObject
          remoteAudioRef.current.srcObject = remoteStream;

          // CRITICAL: Force unmute dan set volume SEBELUM play
          remoteAudioRef.current.muted = false;
          remoteAudioRef.current.volume = 1.0;

          // Tambah event listener untuk monitoring
          remoteAudioRef.current.onloadedmetadata = () => {
            console.log("Remote audio metadata loaded");
            if (remoteAudioRef.current) {
              remoteAudioRef.current.play()
                .then(() => console.log("✅ Remote audio PLAYING!"))
                .catch((err) => {
                  console.error("❌ Audio autoplay blocked:", err);
                  alert("Klik OK untuk mendengar audio lawan bicara");
                  remoteAudioRef.current?.play();
                });
            }
          };
        }

        // Analisis volume lawan
        try {
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(remoteStream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);

          const animateOpponent = () => {
            analyser.getByteFrequencyData(dataArray);
            let sumSquares = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const val = dataArray[i] / 255;
              sumSquares += val * val;
            }
            const rms = Math.sqrt(sumSquares / dataArray.length);
            const volume = Math.min(100, rms * 200);
            setSpeaking((prev) => ({ ...prev, [peerId]: volume }));
            remoteAnimationFrameRef.current = requestAnimationFrame(animateOpponent);
          };
          animateOpponent();
        } catch (err) {
          console.error("Remote audio analysis error:", err);
        }
      }
    };

    // Jika initiator, buat offer setelah semua setup selesai
    if (initiator) {
      // Tunggu sebentar untuk memastikan tracks sudah ditambahkan
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log("Creating offer as initiator...");
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false
      });
      await pc.setLocalDescription(offer);
      console.log("Sending offer to:", peerId);
      wsRef.current?.send(JSON.stringify({
        type: "offer",
        from: clientId,
        to: peerId,
        offer
      }));
    }
  }

  async function handleOffer(offer: any, from: string) {
    console.log("Handling offer from:", from);
    await startWebRTC(from, false);
    if (!pcRef.current) {
      console.error("No peer connection!");
      return;
    }
    console.log("Setting remote description (offer)");
    await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
    console.log("Creating answer...");
    const answer = await pcRef.current.createAnswer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false
    });
    await pcRef.current.setLocalDescription(answer);
    console.log("Sending answer to:", from);
    wsRef.current?.send(JSON.stringify({
      type: "answer",
      from: clientId,
      to: from,
      answer
    }));
  }

  async function handleAnswer(answer: any) {
    if (!pcRef.current) {
      console.error("No peer connection for answer!");
      return;
    }
    await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
    console.log("Answer set");
  }

  async function handleIce(candidate: any) {
    if (!pcRef.current) {
      console.error("No peer connection for ICE!");
      return;
    }
    try {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      console.log("ICE candidate added");
    } catch (err) {
      console.error("ICE error:", err);
    }
  }

  /* ================= UI ================= */
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold mb-2 text-center text-indigo-900">🎙️ Voice Chat</h1>
        <p className="text-center text-gray-600 mb-8">ID: {clientId.slice(0, 8)}</p>

        {/* Status Card */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-4 h-4 rounded-full ${micStatus === "active" ? "bg-green-500 animate-pulse" :
                micStatus === "muted" ? "bg-gray-400" : "bg-red-500"
                }`}></div>
              <span className="font-medium text-gray-700">
                {micStatus === "active" ? "🎤 Mikrofon Aktif" :
                  micStatus === "muted" ? "🔇 Mikrofon Muted" : "❌ Mikrofon Error"}
              </span>
            </div>
            <button
              className={`px-4 py-2 rounded-lg font-medium transition ${micStatus === "broken"
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : micStatus === "active"
                  ? "bg-red-500 hover:bg-red-600 text-white"
                  : "bg-green-500 hover:bg-green-600 text-white"
                }`}
              onClick={toggleMic}
              disabled={micStatus === "broken" || !currentPeer}
            >
              {micStatus === "active" ? "Mute" : "Unmute"}
            </button>
          </div>

          {/* Voice Meter (Self) */}
          {micStatus === "active" && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Volume:</span>
                <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-green-400 to-green-600 transition-all duration-75"
                    style={{ width: `${speaking[clientId] || 0}%` }}
                  ></div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Call Status */}
        {callStatus !== "idle" && (
          <div className="bg-indigo-600 text-white rounded-lg shadow-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm opacity-90">
                  {callStatus === "calling" ? "📞 Memanggil..." : "✓ Terhubung dengan"}
                </p>
                <p className="text-xl font-bold">{currentPeerName}</p>
              </div>
              <button
                className="bg-red-500 hover:bg-red-600 px-6 py-3 rounded-lg font-medium"
                onClick={() => hangupCall()}
              >
                🔴 Akhiri
              </button>
            </div>

            {/* Remote Voice Meter */}
            {callStatus === "connected" && currentPeer && (
              <div className="mt-3 pt-3 border-t border-indigo-500">
                <div className="flex items-center gap-2">
                  <span className="text-sm">Volume lawan:</span>
                  <div className="flex-1 h-3 bg-indigo-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-300 to-blue-500 transition-all duration-75"
                      style={{ width: `${speaking[currentPeer] || 0}%` }}
                    ></div>
                  </div>
                </div>
                <button
                  className="mt-2 w-full bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-2 rounded text-sm"
                  onClick={forcePlayRemoteAudio}
                >
                  🔊 Paksa Play Audio (jika tidak terdengar)
                </button>
              </div>
            )}
          </div>
        )}

        {/* Online Users */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-xl font-bold mb-4 text-gray-800">
            👥 Pengguna Online ({users.length})
          </h2>

          {users.length === 0 ? (
            <p className="text-center text-gray-400 py-8">Tidak ada pengguna online</p>
          ) : (
            <div className="space-y-3">
              {users.map((u) => {
                const volume = speaking[u.client_id] || 0;
                const isInCall = currentPeer === u.client_id;

                return (
                  <div
                    key={u.client_id}
                    className={`flex justify-between items-center p-4 border-2 rounded-lg transition ${isInCall
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-gray-200 hover:border-indigo-300"
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                        {u.name[0]}
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">{u.name}</p>
                        <p className="text-xs text-gray-500">{u.client_id.slice(0, 8)}</p>
                      </div>

                      {/* Voice indicator */}
                      {volume > 5 && (
                        <div className="ml-2 w-6 h-12 bg-gray-200 rounded relative overflow-hidden">
                          <div
                            className="bg-green-500 w-full absolute bottom-0 transition-all duration-75"
                            style={{ height: `${volume}%` }}
                          ></div>
                        </div>
                      )}
                    </div>

                    <button
                      className={`px-5 py-2 rounded-lg font-medium transition ${isInCall
                        ? "bg-gray-300 text-gray-600 cursor-not-allowed"
                        : "bg-green-500 hover:bg-green-600 text-white"
                        }`}
                      onClick={() => callUser(u.client_id)}
                      disabled={isInCall || callStatus !== "idle"}
                    >
                      {isInCall ? "📞 Sedang Call" : "📞 Panggil"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Incoming Call Modal */}
        {incoming && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center animate-bounce">
              <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-blue-500 rounded-full mx-auto mb-4 flex items-center justify-center text-white text-4xl">
                📞
              </div>
              <h3 className="text-2xl font-bold mb-2 text-gray-800">Panggilan Masuk</h3>
              <p className="text-gray-600 mb-6 text-lg">{incoming.name}</p>
              <div className="flex gap-4">
                <button
                  className="flex-1 bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-xl font-medium text-lg"
                  onClick={() => acceptCall(incoming.from)}
                >
                  ✓ Terima
                </button>
                <button
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-xl font-medium text-lg"
                  onClick={() => rejectCall(incoming.from)}
                >
                  ✗ Tolak
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Remote Audio Element - UNMUTED by default */}
        <audio ref={remoteAudioRef} autoPlay playsInline muted={false} />
      </div>
    </div>
  );
}