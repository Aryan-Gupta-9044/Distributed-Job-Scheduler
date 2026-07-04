import { Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";

let io: IOServer | null = null;

export function initSocket(httpServer: HttpServer) {
  io = new IOServer(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    // Clients join per-queue / per-org rooms so updates aren't broadcast globally.
    socket.on("subscribe:queue", (queueId: string) => socket.join(`queue:${queueId}`));
    socket.on("subscribe:worker", (workerId: string) => socket.join(`worker:${workerId}`));
    socket.on("subscribe:dashboard", (orgId: string) => socket.join(`org:${orgId}`));
  });

  return io;
}

export function emitJobUpdate(payload: { jobId: string; queueId: string; status: string }) {
  io?.to(`queue:${payload.queueId}`).emit("job:update", payload);
}

export function emitWorkerUpdate(payload: { workerId: string; status: string; activeJobCount: number }) {
  io?.to(`worker:${payload.workerId}`).emit("worker:update", payload);
}

export function emitQueueStats(orgId: string, stats: unknown) {
  io?.to(`org:${orgId}`).emit("queue:stats", stats);
}
