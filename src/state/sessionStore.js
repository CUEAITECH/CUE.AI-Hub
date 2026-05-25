export function applyLogin(state, { token, user }) {
  return {
    ...state,
    isAuthenticated: true,
    token: token || '',
    user: user || null,
  };
}

export function clearSession(state) {
  return {
    ...state,
    isAuthenticated: false,
    token: '',
    user: null,
  };
}
