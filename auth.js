// ===== SENNA — Auth Guard =====
// Checks if user is authenticated, redirects to login if not

let sennaSupabase = null;

(async function initAuthGuard() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    sennaSupabase = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

    const ALLOWED_DOMAIN = 'romper.global';
    const { data: { session } } = await sennaSupabase.auth.getSession();
    if (!session) {
      window.location.href = '/login.html';
      return;
    }

    // Block non-allowed domains
    const userEmail = session.user.email || '';
    if (!userEmail.endsWith('@' + ALLOWED_DOMAIN)) {
      await sennaSupabase.auth.signOut();
      window.location.href = '/login.html';
      return;
    }

    // Make user info available globally
    window.sennaUser = session.user;
    window.sennaSupabase = sennaSupabase;

    // Update profile UI with real user data
    const name = session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Usuario';
    const avatar = session.user.user_metadata?.avatar_url || session.user.user_metadata?.picture;

    document.querySelectorAll('.profile-name').forEach(el => el.textContent = name);

    if (avatar) {
      document.querySelectorAll('.profile-avatar img').forEach(img => {
        img.src = avatar;
        img.style.display = 'block';
        const fallback = img.nextElementSibling;
        if (fallback) fallback.style.display = 'none';
      });
    }

    // Listen for auth changes
    sennaSupabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        window.location.href = '/login.html';
      }
    });
  } catch (err) {
    console.error('Auth guard error:', err);
  }
})();
