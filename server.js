import express from "express";
import {createServer} from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import {dirname,join} from 'path';


const app = express();
const server = createServer(app);
const io = new Server(server);

const __dirname = dirname(fileURLToPath(import.meta.url));


//exposing public directory to outside

app.use(express.static("public"));

//handle incoming requests
app.get("/",(req,res)=> {
    console.log("GET Request /");
   // res.send("Hello from the server");
   res.sendFile(join(__dirname + "/app/index.html"));
});
//handle socket connections
io.on("connection", (socket) => {
    console.log('someone connected to socket server and socket id is ${socket.id}');
});

app.listen(9000, () => {
    console.log(". server is running on port 9000");
});