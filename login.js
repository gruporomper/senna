// ===== SENNA — Login =====

let supabase = null;

// Load Supabase config from server
async function initAuth() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    // Load Supabase JS library
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    script.onload = () => {
      supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
      checkSession();
    };
    document.head.appendChild(script);
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// Check if user is already logged in
async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    window.location.href = '/';
  }
}

// Google Sign In
document.getElementById('googleSignIn').addEventListener('click', async () => {
  if (!supabase) {
    showError('Carregando... tente novamente em instantes.');
    return;
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin
    }
  });

  if (error) {
    showError(error.message);
  }
});

// Email Magic Link
document.getElementById('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!supabase) {
    showError('Carregando... tente novamente em instantes.');
    return;
  }

  const email = document.getElementById('emailInput').value.trim();
  if (!email) return;

  const btn = document.querySelector('#emailForm button');
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  const { error } = await supabase.auth.signInWithOtp({
    email: email,
    options: {
      emailRedirectTo: window.location.origin
    }
  });

  btn.disabled = false;
  btn.innerHTML = 'Continuar com e-mail &nbsp;→';

  if (error) {
    showError(error.message);
  } else {
    document.getElementById('emailForm').classList.add('hidden');
    document.getElementById('magicSent').classList.remove('hidden');
  }
});

function showError(msg) {
  const errorEl = document.getElementById('loginError');
  document.getElementById('errorText').textContent = msg;
  errorEl.classList.remove('hidden');
  setTimeout(() => errorEl.classList.add('hidden'), 5000);
}

// ===== Background Particles =====
const canvas = document.getElementById('bgParticles');
const ctx = canvas.getContext('2d');
let particles = [];

function initParticles() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  particles = [];
  const count = Math.min(60, Math.floor((canvas.width * canvas.height) / 15000));
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      size: Math.random() * 1.5 + 0.5,
      opacity: Math.random() * 0.4 + 0.1,
      color: ['#FFD700', '#009B3A', '#0047CC'][Math.floor(Math.random() * 3)]
    });
  }
}

function animateParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
    if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = p.opacity;
    ctx.fill();
  });

  ctx.globalAlpha = 0.03;
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 100) {
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  requestAnimationFrame(animateParticles);
}

window.addEventListener('resize', initParticles);
initParticles();
animateParticles();
initAuth();
