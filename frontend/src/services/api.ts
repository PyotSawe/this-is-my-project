import axios from 'axios';
import { 
  AuthResponse, 
  PostsResponse, 
  Post, 
  CommentsResponse, 
  Comment,
  DashboardMetrics,
  TagInsights,
  AIGenerationRequest,
  AIGenerationResponse,
  LoginFormData,
  SignupFormData,
  PostFormData,
  CommentFormData,
  SearchParams
} from '../types';

// Get base URL from environment variable or fallback to proxy
const getBaseURL = () => {
  if (import.meta.env.PROD && import.meta.env.VITE_API_URL) {
    return `${import.meta.env.VITE_API_URL}/api`;
  }
  return '/api'; // Will be proxied to http://localhost:5000/api by Vite in dev
};

// Create axios instance with base configuration
const api = axios.create({
  baseURL: getBaseURL(),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// List of public endpoints that don't require authentication
const publicEndpoints = [
  '/posts',
  '/posts/recent'
];

// Check if an endpoint is public (doesn't require auth)
const isPublicEndpoint = (url: string): boolean => {
  // Handle single post endpoint (/posts/:id)
  if (url.match(/^\/posts\/[a-zA-Z0-9]+$/)) {
    return true;
  }
  
  // Handle comments endpoint (/comments/:postId)
  if (url.match(/^\/comments\/[a-zA-Z0-9]+$/)) {
    return true;
  }
  
  // Check exact matches for other public endpoints
  return publicEndpoints.some(endpoint => url === endpoint || url.startsWith(endpoint + '?'));
};

// Request interceptor to add auth token only for protected endpoints
api.interceptors.request.use(
  (config) => {
    const url = config.url || '';
    
    // Only add auth header for protected endpoints
    if (!isPublicEndpoint(url)) {
      // In development, use the dev token if no token exists in localStorage
      let token = localStorage.getItem('token');
      
      if (!token && import.meta.env.DEV && import.meta.env.VITE_DEV_TOKEN) {
        token = import.meta.env.VITE_DEV_TOKEN;
        console.log('Using development token:', token);
      }
      
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only auto-logout for auth-specific endpoints, not for all 401s
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      
      // Only auto-logout for auth endpoints (like /auth/me) or if it's a token verification failure
      // Let other components handle 401s for their specific use cases
      if (url.includes('/auth/me') || url.includes('/auth/profile')) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
      // For other endpoints, just pass the error through to be handled by the component
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  login: async (credentials: LoginFormData): Promise<AuthResponse> => {
    const response = await api.post('/auth/login', credentials);
    return response.data;
  },

  signup: async (userData: SignupFormData): Promise<AuthResponse> => {
    const formData = new FormData();
    formData.append('name', userData.name);
    formData.append('email', userData.email);
    formData.append('password', userData.password);
    if (userData.profileImage) {
      formData.append('profileImage', userData.profileImage);
    }

    const response = await api.post('/auth/signup', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/auth/me');
    return response.data;
  },

  updateProfile: async (userData: FormData) => {
    const response = await api.put('/auth/profile', userData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  logout: async () => {
    const response = await api.post('/auth/logout');
    return response.data;
  },
};

// Posts API
export const postsAPI = {
  getPosts: async (params: SearchParams = {}): Promise<PostsResponse> => {
    const response = await api.get('/posts', { params });
    return response.data;
  },

  getRecentPosts: async (limit: number = 5) => {
    const response = await api.get('/posts/recent', { params: { limit } });
    return response.data;
  },

  getPost: async (id: string): Promise<{ post: Post }> => {
    const response = await api.get(`/posts/${id}`);
    return response.data;
  },

  createPost: async (postData: PostFormData): Promise<{ post: Post }> => {
    const formData = new FormData();
    formData.append('title', postData.title);
    formData.append('content', postData.content);
    if (postData.excerpt) formData.append('excerpt', postData.excerpt);
    
    // Handle tags properly - send as a comma-separated string
    if (Array.isArray(postData.tags)) {
      formData.append('tags', postData.tags.join(','));
    } else if (typeof postData.tags === 'string') {
      formData.append('tags', postData.tags);
    } else {
      formData.append('tags', '');
    }
    
    formData.append('status', postData.status);
    if (postData.seoTitle) formData.append('seoTitle', postData.seoTitle);
    if (postData.seoDescription) formData.append('seoDescription', postData.seoDescription);
    formData.append('featured', String(postData.featured));
    if (postData.coverImage) formData.append('coverImage', postData.coverImage);

    const response = await api.post('/posts', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  updatePost: async (id: string, postData: any): Promise<{ post: Post }> => {
    const formData = new FormData();
    formData.append('title', postData.title);
    formData.append('content', postData.content);
    if (postData.excerpt) formData.append('excerpt', postData.excerpt);
    
    // Handle tags properly - send as a string if it's an array
    if (Array.isArray(postData.tags)) {
      formData.append('tags', postData.tags.join(','));
    } else {
      formData.append('tags', postData.tags || '');
    }
    
    formData.append('status', postData.status);
    if (postData.seoTitle) formData.append('seoTitle', postData.seoTitle);
    if (postData.seoDescription) formData.append('seoDescription', postData.seoDescription);
    formData.append('featured', String(postData.featured));
    if (postData.coverImage) formData.append('coverImage', postData.coverImage);

    const response = await api.put(`/posts/${id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  deletePost: async (id: string) => {
    const response = await api.delete(`/posts/${id}`);
    return response.data;
  },

  likePost: async (id: string) => {
    const response = await api.post(`/posts/${id}/like`);
    return response.data;
  },

  summarizePost: async (id: string): Promise<{ summary: string }> => {
    const response = await api.post(`/posts/${id}/summarize`);
    return response.data;
  },

  generatePost: async (request: AIGenerationRequest): Promise<AIGenerationResponse> => {
    const response = await api.post('/posts/generate-ai', request);
    return response.data;
  },

  generateContent: async (prompt: string) => {
    const response = await api.post('/posts/generate-content', { prompt });
    return response.data;
  },

  improveTitle: async (title: string) => {
    const response = await api.post('/posts/improve-title', { title });
    return response.data;
  },

  generateExcerpt: async (content: string) => {
    const response = await api.post('/posts/generate-excerpt', { content });
    return response.data;
  },
};

// Comments API
export const commentsAPI = {
  getComments: async (postId: string, page = 1, limit = 20): Promise<CommentsResponse> => {
    const response = await api.get(`/comments/${postId}`, {
      params: { page, limit }
    });
    return response.data;
  },

  addComment: async (postId: string, commentData: CommentFormData): Promise<{ comment: Comment }> => {
    const response = await api.post(`/comments/${postId}`, commentData);
    return response.data;
  },

  addReply: async (commentId: string, commentData: CommentFormData): Promise<{ comment: Comment }> => {
    const response = await api.post(`/comments/${commentId}/reply`, commentData);
    return response.data;
  },

  updateComment: async (commentId: string, commentData: CommentFormData): Promise<{ comment: Comment }> => {
    const response = await api.put(`/comments/${commentId}`, commentData);
    return response.data;
  },

  deleteComment: async (commentId: string) => {
    const response = await api.delete(`/comments/${commentId}`);
    return response.data;
  },

  likeComment: async (commentId: string) => {
    const response = await api.post(`/comments/${commentId}/like`);
    return response.data;
  },

  generateAIReply: async (commentId: string, tone = 'friendly'): Promise<{ generatedReply: string }> => {
    const response = await api.post(`/comments/${commentId}/generate-ai-reply`, { tone });
    return response.data;
  },
};

// Admin API
export const adminAPI = {
  getDashboardMetrics: async (): Promise<DashboardMetrics> => {
    const response = await api.get('/admin/dashboard-metrics');
    return response.data;
  },

  getTagInsights: async (): Promise<TagInsights> => {
    const response = await api.get('/admin/tag-insights');
    return response.data;
  },

  getTopPosts: async (limit = 10, sort = 'views') => {
    const response = await api.get('/admin/top-posts', {
      params: { limit, sort }
    });
    return response.data;
  },

  getRecentComments: async (limit = 10) => {
    const response = await api.get('/admin/recent-comments', {
      params: { limit }
    });
    return response.data;
  },

  getAllPosts: async (page = 1, limit = 10, status = 'all') => {
    const response = await api.get('/admin/posts', {
      params: { page, limit, status }
    });
    return response.data;
  },

  getAllComments: async (page = 1, limit = 20, approved?: boolean) => {
    const response = await api.get('/admin/comments', {
      params: { page, limit, approved }
    });
    return response.data;
  },

  getSystemMetrics: async () => {
    const response = await api.get('/admin/system-metrics');
    return response.data;
  },

  toggleUserStatus: async (userId: string, isActive: boolean) => {
    const response = await api.put(`/admin/users/${userId}/status`, { isActive });
    return response.data;
  },

  deleteUser: async (userId: string) => {
    const response = await api.delete(`/admin/users/${userId}`);
    return response.data;
  },

  updateUserRole: async (userId: string, role: 'user' | 'admin' | 'moderator') => {
    const response = await api.put(`/admin/users/${userId}/role`, { role });
    return response.data;
  },

  bulkUserAction: async (userIds: string[], action: 'activate' | 'deactivate' | 'delete') => {
    const response = await api.post('/admin/users/bulk-action', { userIds, action });
    return response.data;
  },

  createUser: async (newUser: { name: string; email: string; role: 'user' | 'admin' | 'moderator'; password: string; }) => {
    const response = await api.post('/admin/users', newUser);
    return response.data;
  },

  getAllUsers: async (page = 1, limit = 20, role = 'all') => {
    const response = await api.get('/admin/users', {
      params: { page, limit, role }
    });
    return response.data;
  },

  approveComment: async (commentId: string, isApproved: boolean) => {
    const response = await api.put(`/comments/${commentId}/approve`, { isApproved });
    return response.data;
  },

  getAnalytics: async (period = '30') => {
    const response = await api.get('/admin/analytics', {
      params: { period }
    });
    return response.data;
  },

  getPost: async (id: string): Promise<{ post: Post }> => {
    const response = await api.get(`/admin/posts/${id}`);
    return response.data;
  },
};

// Upload API
export const uploadAPI = {
  uploadProfileImage: async (file: File) => {
    const formData = new FormData();
    formData.append('profileImage', file);
    
    const response = await api.post('/upload/profile', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  uploadCoverImage: async (file: File) => {
    const formData = new FormData();
    formData.append('coverImage', file);
    
    const response = await api.post('/upload/post-cover', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  uploadMultipleImages: async (files: File[]) => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });
    
    const response = await api.post('/upload/multiple', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },
};

export default api;
