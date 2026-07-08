'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

interface AuthState {
  token: string | null;
  userName: string | null;
  userId: number | null;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (token: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  userName: null,
  userId: null,
  isAuthenticated: false,
  login: async () => false,
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    token: null,
    userName: null,
    userId: null,
    isAuthenticated: false,
  });

  // 从 localStorage 恢复 token
  useEffect(() => {
    const savedToken = localStorage.getItem('experiment_token');
    if (savedToken) {
      login(savedToken).catch(() => {
        localStorage.removeItem('experiment_token');
      });
    }
  }, []);

  const login = useCallback(async (token: string): Promise<boolean> => {
    try {
      const resp = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await resp.json();
      if (data.valid && data.user) {
        setState({
          token,
          userName: data.user.name,
          userId: data.user.id,
          isAuthenticated: true,
        });
        localStorage.setItem('experiment_token', token);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    setState({
      token: null,
      userName: null,
      userId: null,
      isAuthenticated: false,
    });
    localStorage.removeItem('experiment_token');
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
