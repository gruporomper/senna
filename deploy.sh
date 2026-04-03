#!/bin/bash
# SENNA — Deploy Script para VPS Hostinger
# Rodar como root no terminal da VPS

set -e

echo "========================================="
echo "  SENNA — Deploy na VPS"
echo "========================================="

# 1. Atualizar sistema e instalar dependências
echo "[1/7] Instalando dependências..."
apt update -y && apt upgrade -y
apt install -y nginx certbot python3-certbot-nginx git curl

# 2. Instalar Node.js 20 LTS
echo "[2/7] Instalando Node.js..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
echo "Node: $(node -v) | NPM: $(npm -v)"

# 3. Instalar PM2
echo "[3/7] Instalando PM2..."
npm install -g pm2

# 4. Clonar repositório
echo "[4/7] Clonando repositório..."
mkdir -p /var/www
cd /var/www

if [ -d "senna" ]; then
  cd senna
  git pull origin main
else
  git clone https://github.com/gruporomper/senna.git
  cd senna
fi

# 5. Criar .env
echo "[5/7] Configurando .env..."
# Se .env não existe, criar template (preencher manualmente)
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
GROK_API_KEY=REPLACE_WITH_YOUR_KEY
ELEVENLABS_API_KEY=REPLACE_WITH_YOUR_KEY
ELEVENLABS_VOICE_ID=REPLACE_WITH_YOUR_ID
SUPABASE_URL=REPLACE_WITH_YOUR_URL
SUPABASE_ANON_KEY=REPLACE_WITH_YOUR_KEY
PORT=3000
ENVEOF
  echo "⚠️  .env criado com placeholders — preencha as chaves manualmente!"
else
  echo "✓ .env já existe, mantendo chaves atuais."
fi

# 6. Iniciar com PM2
echo "[6/7] Iniciando SENNA com PM2..."
pm2 stop senna 2>/dev/null || true
pm2 delete senna 2>/dev/null || true
pm2 start server.js --name senna
pm2 save
pm2 startup systemd -u root --hp /root

# 7. Configurar Nginx
echo "[7/7] Configurando Nginx..."
cat > /etc/nginx/sites-available/senna << 'NGINXEOF'
server {
    listen 80;
    server_name senna.romper.global;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/senna /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo ""
echo "========================================="
echo "  SENNA deploy completo!"
echo "  Acesse: http://senna.romper.global"
echo ""
echo "  Próximo passo: configurar DNS no Cloudflare"
echo "  Tipo A → senna → 72.60.123.52 (proxy OFF)"
echo "  Depois rodar: certbot --nginx -d senna.romper.global"
echo "========================================="
