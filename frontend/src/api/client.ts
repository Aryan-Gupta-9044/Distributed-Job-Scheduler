import axios from "axios";

export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const api = axios.create({ baseURL: `${API_BASE}/api` });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem("token");
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

export function setSession(token: string) {
  localStorage.setItem("token", token);
}

export function clearSession() {
  localStorage.removeItem("token");
}

export function getToken() {
  return localStorage.getItem("token");
}
