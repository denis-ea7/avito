module.exports = {
  apps: [
    {
      name: 'avito-web',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1200M',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '4076',
        AUTO_START_BOT: '1'
      }
    }
  ]
};
