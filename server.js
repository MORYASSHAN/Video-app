import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const server = createServer(app);
const io = new Server(server);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 9000;

// socket.id -> { id, username, inCallWith }
const users = new Map();

// exposing public directory to outside
app.use(express.static(join(__dirname, "public")));

// handle incoming requests
app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "app", "index.html"));
});

const publicUserList = () =>
    [...users.values()].map(({ id, username, inCallWith }) => ({
        id,
        username,
        busy: Boolean(inCallWith),
    }));

const broadcastUsers = () => io.emit("users", publicUserList());

// Forward a signaling message to another socket, tagged with the sender.
const relay = (socket, event, to, payload = {}) => {
    if (!users.has(socket.id) || !users.has(to)) return false;
    io.to(to).emit(event, { ...payload, from: socket.id });
    return true;
};

const endCall = (socketId, notifyPeer = true) => {
    const user = users.get(socketId);
    if (!user || !user.inCallWith) return;
    const peer = users.get(user.inCallWith);
    user.inCallWith = null;
    if (peer && peer.inCallWith === socketId) {
        peer.inCallWith = null;
        if (notifyPeer) io.to(peer.id).emit("call-ended", { from: socketId });
    }
};

// handle socket connections
io.on("connection", (socket) => {
    console.log(`socket connected: ${socket.id}`);

    socket.on("join-user", (rawName, ack) => {
        const username = String(rawName ?? "").trim().slice(0, 32);
        const reply = typeof ack === "function" ? ack : () => {};

        if (!username) return reply({ ok: false, error: "Please enter a name." });

        const taken = [...users.values()].some(
            (u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== socket.id
        );
        if (taken) return reply({ ok: false, error: "That name is already taken." });

        users.set(socket.id, { id: socket.id, username, inCallWith: null });
        console.log(`${username} joined (${socket.id})`);
        reply({ ok: true, id: socket.id, username });
        broadcastUsers();
    });

    // Caller -> callee: SDP offer starts a call.
    socket.on("offer", ({ to, offer }) => {
        const caller = users.get(socket.id);
        const callee = users.get(to);
        if (!caller || !callee) return socket.emit("call-failed", { reason: "User is no longer online." });
        if (caller.inCallWith) return socket.emit("call-failed", { reason: "You are already in a call." });
        if (callee.inCallWith) return socket.emit("call-failed", { reason: `${callee.username} is busy.` });

        caller.inCallWith = callee.id;
        callee.inCallWith = caller.id;
        relay(socket, "offer", to, { offer, username: caller.username });
        broadcastUsers();
    });

    // Callee -> caller: SDP answer accepts the call.
    socket.on("answer", ({ to, answer }) => {
        if (users.get(socket.id)?.inCallWith !== to) return;
        relay(socket, "answer", to, { answer });
    });

    socket.on("icecandidate", ({ to, candidate }) => {
        if (users.get(socket.id)?.inCallWith !== to) return;
        relay(socket, "icecandidate", to, { candidate });
    });

    socket.on("reject-call", ({ to }) => {
        if (users.get(socket.id)?.inCallWith !== to) return;
        relay(socket, "call-rejected", to);
        endCall(socket.id, false);
        broadcastUsers();
    });

    socket.on("end-call", () => {
        endCall(socket.id);
        broadcastUsers();
    });

    socket.on("disconnect", () => {
        const user = users.get(socket.id);
        endCall(socket.id);
        users.delete(socket.id);
        if (user) console.log(`${user.username} left (${socket.id})`);
        broadcastUsers();
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
