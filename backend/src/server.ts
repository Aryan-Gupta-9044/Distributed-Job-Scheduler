import express from "express";
import cors from "cors";
import { createServer } from "http";
import { pinoHttp } from "pino-http";
import { config } from "./config/env.js";
import { errorMiddleware } from "./utils/errors.js";
import { initSocket } from "./realtime/socket.js";
import { authRouter } from "./routes/auth.routes.js";
import { orgsRouter } from "./routes/orgs.routes.js";
import { queuesRouter } from "./routes/queues.routes.js";
import { jobsRouter } from "./routes/jobs.routes.js";
import { workersRouter } from "./routes/workers.routes.js";
import { dlqRouter } from "./routes/dlq.routes.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(pinoHttp());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api", queuesRouter);
app.use("/api", jobsRouter);
app.use("/api", workersRouter);
app.use("/api", dlqRouter);

app.use(errorMiddleware);

const httpServer = createServer(app);
initSocket(httpServer);

httpServer.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${config.port}`);
});
