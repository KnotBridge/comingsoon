import { createContext, useContext } from "react";

// Minimal stub. The mail manager is gated by a single shared access code, not
// per-user auth, so there is one implicit admin "user". Some ported components
// call useAuth() only to read the current user id; null is fine here.
interface AuthValue {
  user: { id: string } | null;
}

const AuthContext = createContext<AuthValue>({ user: null });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <AuthContext.Provider value={{ user: null }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}
