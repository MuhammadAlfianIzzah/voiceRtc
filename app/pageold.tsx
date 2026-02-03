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
            .then(stream => {
                localStreamRef.current = stream;
                setMicStatus("active");
                console.log("🎤 Mic ready, tracks:", stream.getTracks());
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
                    setSpeaking(prev => ({ ...prev, [id!]: volume }));
                    animationFrameRef.current = requestAnimationFrame(animateMic);
                };
                animateMic();
            })
            .catch(err => {
                console.error("❌ Mic error:", err);
                setMicStatus("broken");
                alert("Microphone tidak terdeteksi atau izin ditolak.");
            });
        const ws = new WebSocket("wss://ws-voicertc-production.up.railway.app");
        wsRef.current = ws;

        ws.onopen = () => {
            console.log("✅ WS connected");
            ws.send(JSON.stringify({ type: "join", client_id: id, name: "User-" + id.slice(0, 4) }));
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            console.log("📨 WS message received:", msg);

            switch (msg.type) {
                case "user-list":
                    setUsers(msg.users.filter((u: User) => u.client_id !== id));
                    break;
                case "call":
                    console.log("📞 Incoming call from:", msg.from);
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
                    console.warn("❌ Call rejected");
                    alert("Panggilan ditolak");
                    setCurrentPeer(null);
                    setCallStatus("idle");
                    break;
                case "offer":
                    console.log("📤 Offer received from:", msg.from);
                    handleOffer(msg.offer, msg.from);
                    break;
                case "answer":
                    console.log("📥 Answer received");
                    handleAnswer(msg.answer);
                    break;
                case "ice":
                    console.log("🧊 ICE candidate received");
                    handleIce(msg.candidate);
                    break;
                case "call-ended":
                    console.warn("📴 Call ended");
                    hangupCall(false);
                    alert("Panggilan berakhir");
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
        console.log("📞 Calling user:", to);
        const user = users.find(u => u.client_id === to);
        startWebRTC(to, true);
        wsRef.current?.send(JSON.stringify({ type: "call", from: clientId, to }));

        setCurrentPeer(to);
        setCurrentPeerName(user?.name || "Unknown");
        setCallStatus("calling");
    }

    function acceptCall(from: string) {
        console.log("✅ Accepting call from:", from);
        startWebRTC(from, false);
        wsRef.current?.send(JSON.stringify({ type: "call-accept", from: clientId, to: from }));
        setCurrentPeer(from);
        setCurrentPeerName(incoming?.name || "Unknown");
        setCallStatus("connected");
        setIncoming(null);

        setTimeout(() => {
            forcePlayRemoteAudio();
        }, 200);
    }

    function hangupCall(sendSignal = true) {
        console.log("📴 Hanging up call");
        if (sendSignal && currentPeer)
            wsRef.current?.send(JSON.stringify({ type: "hangup", from: clientId, to: currentPeer }));

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
        console.log("🎤 Mic toggled:", track.enabled ? "active" : "muted");
        setMicStatus(track.enabled ? "active" : "muted");
    }

    function toggleTestMic() {
        if (!localStreamRef.current) {
            alert("Mic tidak tersedia.");
            return;
        }
        if (!testMicOn) {
            if (!testAudioRef.current) {
                testAudioRef.current = document.createElement("audio");
                testAudioRef.current.autoplay = true;
                testAudioRef.current.srcObject = localStreamRef.current;
            }
            testAudioRef.current.play()
                .then(() => console.log("🎧 Test mic started"))
                .catch(err => console.warn("⚠️ Test mic play failed", err));
            setTestMicOn(true);
        } else {
            testAudioRef.current?.pause();
            console.log("🎧 Test mic stopped");
            setTestMicOn(false);
        }
    }

    function forcePlayRemoteAudio() {
        console.log("▶️ forcePlayRemoteAudio clicked", { currentPeer, audioEl: remoteAudioRef.current });
        if (remoteAudioRef.current) {
            remoteAudioRef.current.muted = false;
            remoteAudioRef.current.volume = 1;
            remoteAudioRef.current.play()
                .then(() => console.log("✅ Remote audio manual play started"))
                .catch(err => console.warn("⚠️ Remote audio manual play failed", err));
        } else {
            console.warn("❌ remoteAudioRef.current belum siap");
        }
    }
    async function startWebRTC(peerId: string, initiator: boolean) {
        if (pcRef.current) return;

        console.log("🔹 startWebRTC", { peerId, initiator });

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });
        pcRef.current = pc;
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!);
                console.log("🎤 Track ditambahkan:", track.kind);
            });
        }

        pc.onicecandidate = e => {
            if (e.candidate) {
                wsRef.current?.send(JSON.stringify({ type: "ice", from: clientId, to: peerId, candidate: e.candidate }));
                console.log("🧊 ICE candidate dikirim:", e.candidate);
            }
        };

        pc.ontrack = e => {
            const [remoteStream] = e.streams;
            console.log("🎵 Remote track diterima:", remoteStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled })));
            remoteStream.getAudioTracks().forEach(track => {
                track.enabled = true;
                console.log("🎚️ Remote track enabled", track);
            });
            if (remoteAudioRef.current) {
                remoteAudioRef.current.srcObject = remoteStream;
                remoteAudioRef.current.muted = false;
                remoteAudioRef.current.volume = 1;
                const tryPlay = () => {
                    remoteAudioRef.current?.play()
                        .then(() => console.log("✅ Remote audio playing"))
                        .catch(err => {
                            console.warn("⚠️ Remote audio play failed, retrying...", err);
                            setTimeout(tryPlay, 200);
                        });
                };
                tryPlay();
            }
            trackRemoteVolume(remoteStream);
        };
        function trackRemoteVolume(stream: MediaStream) {
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            const animateRemote = () => {
                analyser.getByteFrequencyData(dataArray);
                let sumSquares = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const val = dataArray[i] / 255;
                    sumSquares += val * val;
                }
                const rms = Math.sqrt(sumSquares / dataArray.length);
                const volume = rms * 100; // 0-100
                console.log("🎤 Remote volume:", volume.toFixed(2));
                requestAnimationFrame(animateRemote);
            };
            animateRemote();
        }
        pc.oniceconnectionstatechange = () => console.log("ICE state:", pc.iceConnectionState);

        if (initiator) {
            const offer = await pc.createOffer({ offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            wsRef.current?.send(JSON.stringify({ type: "offer", from: clientId, to: peerId, offer }));
            console.log("📤 Offer dikirim:", offer);
        }
    }

    async function handleOffer(offer: any, from: string) {
        console.log("📤 Handling offer from:", from);
        await startWebRTC(from, false);
        if (!pcRef.current) return;

        await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
        iceQueueRef.current.forEach(c => pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn));
        iceQueueRef.current = [];

        const answer = await pcRef.current.createAnswer({ offerToReceiveAudio: true });
        await pcRef.current.setLocalDescription(answer);
        wsRef.current?.send(JSON.stringify({ type: "answer", from: clientId, to: from, answer }));
        console.log("📥 Answer dikirim:", answer);
    }

    async function handleAnswer(answer: any) {
        console.log("📥 Handling answer");
        if (!pcRef.current) return;
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        iceQueueRef.current.forEach(c => pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn));
        iceQueueRef.current = [];
    }

    async function handleIce(candidate: any) {
        console.log("🧊 Handling ICE candidate:", candidate);
        if (!pcRef.current || !pcRef.current.remoteDescription) {
            iceQueueRef.current.push(candidate);
        } else {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
            <div className="max-w-2xl mx-auto">
                <h1 className="text-4xl font-bold mb-2 text-center text-indigo-900">🎙️ Voice Chat</h1>
                <p className="text-center text-gray-600 mb-8">ID: {clientId.slice(0, 8)}</p>
                <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className={`w-4 h-4 rounded-full ${micStatus === "active" ? "bg-green-500 animate-pulse" :
                                micStatus === "muted" ? "bg-gray-400" : "bg-red-500"}`
                            }></div>
                            <span className="font-medium text-gray-700">
                                {micStatus === "active" ? "🎤 Mikrofon Aktif" :
                                    micStatus === "muted" ? "🔇 Mikrofon Muted" : "❌ Mikrofon Error"}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                className={`px-4 py-2 rounded-lg font-medium transition ${micStatus === "broken"
                                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                    : micStatus === "active"
                                        ? "bg-red-500 hover:bg-red-600 text-white"
                                        : "bg-green-500 hover:bg-green-600 text-white"}`
                                }
                                onClick={toggleMic}
                                disabled={micStatus === "broken"}
                            >
                                {micStatus === "active" ? "Mute" : "Unmute"}
                            </button>

                            <button
                                className="px-4 py-2 rounded-lg font-medium bg-blue-500 hover:bg-blue-600 text-white transition"
                                onClick={toggleTestMic}
                                disabled={micStatus === "broken"}
                            >
                                {testMicOn ? "Stop Test Mic" : "🎧 Test Mic"}
                            </button>
                        </div>
                    </div>
                    {micStatus !== "broken" && (
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
                <div className="bg-white rounded-lg shadow-lg p-6">
                    <h2 className="text-xl font-bold mb-4 text-gray-800">
                        👥 Pengguna Online ({users.length})
                    </h2>
                    {users.length === 0 ? (
                        <p className="text-center text-gray-400 py-8">Tidak ada pengguna online</p>
                    ) : (
                        <div className="space-y-3">
                            {users.map((u) => {
                                const isInCall = currentPeer === u.client_id;
                                return (
                                    <div key={u.client_id} className={`flex justify-between items-center p-4 border-2 rounded-lg transition ${isInCall ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-indigo-300"}`}>
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                                                {u.name[0]}
                                            </div>
                                            <div>
                                                <p className="font-medium text-gray-800">{u.name}</p>
                                                <p className="text-xs text-gray-500">{u.client_id.slice(0, 8)}</p>
                                            </div>
                                        </div>
                                        <button className={`px-5 py-2 rounded-lg font-medium transition ${isInCall ? "bg-gray-300 text-gray-600 cursor-not-allowed" : "bg-green-500 hover:bg-green-600 text-white"}`}
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
                {incoming && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center animate-bounce">
                            <h3 className="text-2xl font-bold mb-2 text-gray-800">Panggilan Masuk</h3>
                            <p className="text-gray-600 mb-6 text-lg">{incoming.name}</p>
                            <div className="flex gap-4">
                                <button className="flex-1 bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-xl font-medium text-lg" onClick={() => acceptCall(incoming.from)}>✓ Terima</button>
                                <button className="flex-1 bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-xl font-medium text-lg" onClick={() => hangupCall()}>✗ Tolak</button>
                            </div>
                        </div>
                    </div>
                )}
                <audio
                    ref={remoteAudioRef}
                    autoPlay
                    playsInline
                    muted={false}
                    onPlay={() => console.log("🎵 Remote audio playing")}
                    onPause={() => console.log("⏸️ Remote audio paused")}
                    onError={(e) => console.warn("❌ Remote audio error", e)}
                />
                {currentPeer && (
                    <button
                        onClick={forcePlayRemoteAudio}
                        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg"
                    >
                        ▶️ Putar Suara Lawan
                    </button>
                )}
            </div>
        </div>
    );
}
