const socket = io();

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];
const RING_TIMEOUT_MS = 30000;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const joinScreen = $("join-screen");
const joinForm = $("join-form");
const usernameInput = $("username");
const joinError = $("join-error");
const mainContainer = document.querySelector(".main-container");
const myName = $("my-name");
const allUsersList = $("allusers");
const noUsers = $("no-users");
const localVideo = $("local-video");
const remoteVideo = $("remote-video");
const stageStatus = $("stage-status");
const micBtn = $("toggle-mic");
const camBtn = $("toggle-cam");
const endBtn = $("end-call");
const incomingDialog = $("incoming-call");
const incomingName = $("incoming-name");
const acceptBtn = $("accept-call");
const rejectBtn = $("reject-call");
const toastEl = $("toast");

// ---------- State ----------
let me = null;               // { id, username }
let localStream = null;
let pc = null;               // RTCPeerConnection
let peer = null;             // { id, username } of the other side
let incoming = null;         // { from, username, offer } while ringing
let pendingCandidates = [];  // ICE candidates received before remote description
let ringTimer = null;
let users = [];
let mediaReady = Promise.resolve();

// ---------- Helpers ----------
let toastTimer;
function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3500);
}

function setStatus(text) {
    stageStatus.textContent = text;
    stageStatus.hidden = !text;
}

const PHONE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z"/></svg>';

function renderUsers() {
    const others = users.filter((u) => u.id !== me?.id);
    allUsersList.replaceChildren(
        ...others.map((user) => {
            const li = document.createElement("li");
            li.className = "caller";

            const avatar = document.createElement("span");
            avatar.className = "avatar";
            avatar.textContent = user.username.charAt(0);

            const info = document.createElement("div");
            info.className = "caller-info";
            const name = document.createElement("span");
            name.className = "caller-name";
            name.textContent = user.username;
            const status = document.createElement("span");
            status.className = "caller-status" + (user.busy ? " busy" : "");
            status.textContent = user.busy ? "In a call" : "Online";
            info.append(name, status);

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-success call-btn";
            btn.title = `Call ${user.username}`;
            btn.innerHTML = PHONE_ICON;
            btn.disabled = user.busy || Boolean(pc) || Boolean(incoming);
            btn.addEventListener("click", () => startCall(user));

            li.append(avatar, info, btn);
            return li;
        })
    );
    noUsers.hidden = others.length > 0;
}

// ---------- Media ----------
async function initLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
        console.warn("Camera+mic unavailable, trying audio only", err);
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            toast("Camera unavailable — joining with audio only.");
        } catch (err2) {
            console.warn("No media devices available", err2);
            localStream = null;
            toast(
                window.isSecureContext
                    ? "Couldn't access camera or microphone. You can still receive calls."
                    : "Camera needs HTTPS or localhost. You can still receive video."
            );
        }
    }
    localVideo.srcObject = localStream;
    micBtn.disabled = !localStream?.getAudioTracks().length;
    camBtn.disabled = !localStream?.getVideoTracks().length;
}

function toggleTrack(kind, btn, onTitle, offTitle) {
    const tracks = kind === "audio" ? localStream?.getAudioTracks() : localStream?.getVideoTracks();
    if (!tracks?.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.title = enabled ? onTitle : offTitle;
}

// ---------- WebRTC ----------
function createPeerConnection(remote) {
    peer = remote;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    // Make sure we can still receive audio+video if we have nothing to send.
    const sendingKinds = new Set(localStream?.getTracks().map((t) => t.kind) ?? []);
    ["audio", "video"].forEach((kind) => {
        if (!sendingKinds.has(kind)) pc.addTransceiver(kind, { direction: "recvonly" });
    });

    pc.onicecandidate = ({ candidate }) => {
        if (candidate && peer) socket.emit("icecandidate", { to: peer.id, candidate });
    };

    pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
            remoteVideo.srcObject = stream;
        } else {
            if (!(remoteVideo.srcObject instanceof MediaStream)) remoteVideo.srcObject = new MediaStream();
            remoteVideo.srcObject.addTrack(event.track);
        }
    };

    pc.onconnectionstatechange = () => {
        if (!pc) return;
        switch (pc.connectionState) {
            case "connected":
                clearTimeout(ringTimer);
                setStatus("");
                break;
            case "disconnected":
                setStatus("Connection unstable — reconnecting…");
                break;
            case "failed":
                toast("Connection failed. The network may be blocking peer-to-peer video.");
                hangUp();
                break;
        }
    };

    endBtn.disabled = false;
    renderUsers();
    return pc;
}

async function flushPendingCandidates() {
    const candidates = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of candidates) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (err) {
            console.warn("Failed to add ICE candidate", err);
        }
    }
}

async function startCall(user) {
    await mediaReady;
    if (pc || incoming) return toast("You're already in a call.");
    createPeerConnection(user);
    setStatus(`Calling ${user.username}…`);

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { to: user.id, offer: pc.localDescription });
    } catch (err) {
        console.error(err);
        toast("Could not start the call.");
        return cleanupCall();
    }

    ringTimer = setTimeout(() => {
        if (pc && !pc.remoteDescription) {
            toast(`${user.username} didn't answer.`);
            hangUp();
        }
    }, RING_TIMEOUT_MS);
}

async function acceptCall() {
    if (!incoming) return;
    const { from, username, offer } = incoming;
    incoming = null;
    incomingDialog.close();

    await mediaReady;
    createPeerConnection({ id: from, username });
    setStatus(`Connecting to ${username}…`);
    try {
        await pc.setRemoteDescription(offer);
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { to: from, answer: pc.localDescription });
    } catch (err) {
        console.error(err);
        toast("Could not connect the call.");
        hangUp();
    }
}

function rejectCall() {
    if (!incoming) return;
    socket.emit("reject-call", { to: incoming.from });
    incoming = null;
    pendingCandidates = [];
    incomingDialog.close();
    renderUsers();
}

function hangUp() {
    socket.emit("end-call");
    cleanupCall();
}

function cleanupCall(statusText = "Select a contact to start a call") {
    clearTimeout(ringTimer);
    if (pc) {
        pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
        pc.close();
    }
    pc = null;
    peer = null;
    incoming = null;
    pendingCandidates = [];
    remoteVideo.srcObject = null;
    if (incomingDialog.open) incomingDialog.close();
    endBtn.disabled = true;
    setStatus(statusText);
    renderUsers();
}

// ---------- Socket events ----------
socket.on("users", (list) => {
    users = list;
    if (me) renderUsers();
});

socket.on("offer", ({ from, username, offer }) => {
    if (pc || incoming) {
        // Shouldn't happen (server guards busy users) but be safe.
        socket.emit("reject-call", { to: from });
        return;
    }
    incoming = { from, username, offer };
    pendingCandidates = [];
    incomingName.textContent = username;
    incomingDialog.showModal();
    renderUsers();
});

socket.on("answer", async ({ from, answer }) => {
    if (!pc || peer?.id !== from) return;
    try {
        await pc.setRemoteDescription(answer);
        await flushPendingCandidates();
        setStatus(`Connecting to ${peer.username}…`);
    } catch (err) {
        console.error(err);
        toast("Could not connect the call.");
        hangUp();
    }
});

socket.on("icecandidate", async ({ from, candidate }) => {
    const fromCurrentPeer = pc && peer?.id === from;
    const fromIncoming = incoming?.from === from;
    if (!fromCurrentPeer && !fromIncoming) return;

    if (fromCurrentPeer && pc.remoteDescription) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (err) {
            console.warn("Failed to add ICE candidate", err);
        }
    } else {
        pendingCandidates.push(candidate);
    }
});

socket.on("call-rejected", ({ from }) => {
    if (peer?.id !== from) return;
    toast(`${peer.username} declined the call.`);
    cleanupCall();
});

socket.on("call-ended", ({ from }) => {
    if (incoming?.from === from) {
        toast(`Missed call from ${incoming.username}.`);
        cleanupCall();
    } else if (peer?.id === from) {
        toast(`${peer.username} ended the call.`);
        cleanupCall();
    }
});

socket.on("call-failed", ({ reason }) => {
    toast(reason);
    cleanupCall();
});

socket.on("disconnect", () => {
    if (pc || incoming) toast("Lost connection to the server.");
    cleanupCall("Reconnecting to server…");
});

// Re-register automatically after a server restart / network blip.
socket.on("connect", () => {
    if (!me) return;
    socket.emit("join-user", me.username, (res) => {
        if (res.ok) {
            me = { id: res.id, username: res.username };
            setStatus("Select a contact to start a call");
            renderUsers();
        } else {
            toast(`Reconnected, but couldn't rejoin: ${res.error}`);
        }
    });
});

// ---------- UI events ----------
joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = usernameInput.value.trim();
    if (!username) return;

    const submitBtn = joinForm.querySelector("button");
    submitBtn.disabled = true;
    joinError.textContent = "";

    socket.emit("join-user", username, async (res) => {
        if (!res.ok) {
            joinError.textContent = res.error;
            submitBtn.disabled = false;
            return;
        }
        me = { id: res.id, username: res.username };
        myName.textContent = me.username;
        joinScreen.hidden = true;
        mainContainer.hidden = false;
        renderUsers();
        mediaReady = initLocalStream();
    });
});

micBtn.addEventListener("click", () => toggleTrack("audio", micBtn, "Mute microphone", "Unmute microphone"));
camBtn.addEventListener("click", () => toggleTrack("video", camBtn, "Turn camera off", "Turn camera on"));
endBtn.addEventListener("click", hangUp);
acceptBtn.addEventListener("click", acceptCall);
rejectBtn.addEventListener("click", rejectCall);
// Pressing Escape on the dialog counts as declining.
incomingDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    rejectCall();
});

window.addEventListener("beforeunload", () => {
    if (pc) socket.emit("end-call");
});

usernameInput.focus();
