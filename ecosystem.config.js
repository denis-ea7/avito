module.exports = {
  apps: [
    {
      name: 'realty-parser',
      script: 'avito-cian.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        NODE_TLS_REJECT_UNAUTHORIZED: '0', 
        
        
        
      },
    },
  ],
};
