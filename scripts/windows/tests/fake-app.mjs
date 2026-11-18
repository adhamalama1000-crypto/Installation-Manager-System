// Test helper: another program that occupies port 3000 (it is not OR VIP).
import http from "node:http";

http.createServer((req, res) => res.end("other app")).listen(3000, "127.0.0.1");
