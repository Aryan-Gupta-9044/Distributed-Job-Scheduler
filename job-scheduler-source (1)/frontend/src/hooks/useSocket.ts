import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { API_BASE } from "../api/client.js";

export function useSocket() {
  const ref = useRef<Socket | null>(null);
  useEffect(() => {
    ref.current = io(API_BASE, { transports: ["websocket"] });
    return () => {
      ref.current?.disconnect();
    };
  }, []);
  return ref;
}
