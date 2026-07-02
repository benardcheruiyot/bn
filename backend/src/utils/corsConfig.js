const parseAllowedOrigins = () => (
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

const isOriginAllowedByPattern = (origin, patterns) => {
  return patterns.some((pattern) => {
    if (pattern === origin) return true;

    // Supports entries like https://*.example.com
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      return regex.test(origin);
    }

    return false;
  });
};

const isAllowedByBaseDomain = (origin, baseDomain) => {
  if (!baseDomain) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    const validProtocol = protocol === 'http:' || protocol === 'https:';
    return validProtocol && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`));
  } catch (error) {
    return false;
  }
};

const isLocalDevOrigin = (origin) => {
  try {
    const { hostname, protocol } = new URL(origin);
    const isHttp = protocol === 'http:' || protocol === 'https:';
    return isHttp && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch (error) {
    return false;
  }
};

module.exports = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200,
  origin: (origin, callback) => {
    const isDevelopment = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    const allowedOrigins = parseAllowedOrigins();
    const allowedBaseDomain = (process.env.ALLOWED_BASE_DOMAIN || '').trim();

    // Allow non-browser requests (curl, server-to-server, health checks).
    if (!origin) {
      callback(null, true);
      return;
    }

    const allowed =
      isOriginAllowedByPattern(origin, allowedOrigins)
      || isAllowedByBaseDomain(origin, allowedBaseDomain)
      || (isDevelopment && isLocalDevOrigin(origin));

    if (allowed) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
};
