// API Service
import axios from 'axios';

const API_URL =
  process.env.REACT_APP_API_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5001/api'
    : '/api');

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle response errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    const status = error.response?.status;
    const code = error.code;
    console.error('API Error:', { 
      status,
      data: error.response?.data,
      code,
      message
    });
    const enrichedError = new Error(message);
    enrichedError.code = code;
    enrichedError.status = status;
    enrichedError.isNetworkError = code === 'ERR_NETWORK' || !error.response;
    return Promise.reject(enrichedError);
  }
);

// Auth Service
export const authService = {
  registerOrLogin: async (name, phone_number) => {
    let response;
    try {
      response = await api.post('/auth/register', { name, phone_number });
    } catch (error) {
      const shouldRetry = error.isNetworkError || error.status === 502;
      if (!shouldRetry) {
        throw error;
      }

      // Retry once for transient upstream/network failures.
      response = await api.post('/auth/register', { name, phone_number });
    }
    if (response.data.data.token) {
      localStorage.setItem('token', response.data.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.data.user));
    }
    return response.data.data;
  },

  getProfile: async () => {
    const response = await api.get('/user/profile');
    return response.data.data;
  },

  updateProfile: async (userData) => {
    const response = await api.put('/user/profile', userData);
    return response.data.data;
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },
};

// Loan Service
export const loanService = {
  createApplication: async (amount, termDays) => {
    const response = await api.post('/loans/apply', { amount, termDays });
    return response.data.data;
  },

  getUserLoans: async () => {
    const response = await api.get('/loans');
    return response.data.data;
  },

  getLoanDetails: async (loanId) => {
    const response = await api.get(`/loans/${loanId}`);
    return response.data.data;
  },

  initiateStkPush: async (phone, amount, loanAmount, termDays = 60) => {
    const response = await api.post('/stk_push', {
      phone,
      amount,
      loanAmount,
      termDays,
    });
    return response.data;
  },

  checkPaymentStatus: async (checkoutId) => {
    const response = await api.get('/check_status', {
      params: {
        checkoutId,
        t: Date.now(),
      },
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
    return response.data;
  },
};

export default api;
