document.addEventListener('DOMContentLoaded', () => {

  // Mobile nav toggle
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => navLinks.classList.remove('open'));
    });
  }

  // Active nav link on scroll
  const sections = document.querySelectorAll('.section');
  const navAnchors = document.querySelectorAll('.nav-links a');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navAnchors.forEach(a => {
          a.classList.toggle('active', a.getAttribute('href') === `#${id}`);
        });
      }
    });
  }, { rootMargin: '-40% 0px -50% 0px' });

  sections.forEach(s => observer.observe(s));

  // Synchronized Tier tabs (Workout & Exercises breakdown change based on tier selected)
  document.querySelectorAll('[data-tier]').forEach(tab => {
    tab.addEventListener('click', () => {
      const tier = tab.dataset.tier;
      
      // Sync all tab buttons with matching data-tier
      document.querySelectorAll('[data-tier]').forEach(t => {
        t.classList.toggle('active', t.dataset.tier === tier);
      });

      // Sync all tier panels (workout tables & exercise tips panels)
      document.querySelectorAll('.tier-panel').forEach(p => {
        if (p.id === tier || p.classList.contains(`${tier}-panel`)) {
          p.classList.add('active');
        } else {
          p.classList.remove('active');
        }
      });
    });
  });

  // Nutrition tabs
  document.querySelectorAll('[data-nut]').forEach(tab => {
    tab.addEventListener('click', () => {
      const nut = tab.dataset.nut;
      tab.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.nut-panel').forEach(p => p.classList.remove('active'));
      const target = document.getElementById(nut);
      if (target) target.classList.add('active');
    });
  });

  // Daily Meal Plan tabs
  document.querySelectorAll('[data-day]').forEach(tab => {
    tab.addEventListener('click', () => {
      const day = tab.dataset.day;
      tab.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.day-meal-card').forEach(card => {
        if (day === 'all' || card.dataset.day === day) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });

  // Week progression
  document.querySelectorAll('.week-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const week = btn.dataset.week;
      document.querySelectorAll('.week-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.week-panel').forEach(p => p.classList.remove('active'));
      const target = document.getElementById(`week${week}`);
      if (target) target.classList.add('active');
    });
  });

  // Accordions (works for exercise tips, finishers, and cooking tips)
  document.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const targetId = header.dataset.target;
      const body = document.getElementById(targetId);
      if (!body) return;
      const isOpen = body.classList.contains('open');

      // Close siblings in same accordion list
      const parent = header.closest('.accordion-list');
      if (parent) {
        parent.querySelectorAll('.accordion-body.open').forEach(b => {
          if (b.id !== targetId) {
            b.classList.remove('open');
            b.previousElementSibling?.classList.remove('open');
          }
        });
      }

      body.classList.toggle('open', !isOpen);
      header.classList.toggle('open', !isOpen);
    });
  });

  // Persist checklists in localStorage
  function initChecklist(id) {
    const list = document.getElementById(id);
    if (!list) return;

    const key = `fembody_${id}`;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');

    list.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
      cb.checked = saved[i] || false;
      cb.addEventListener('change', () => {
        const state = {};
        list.querySelectorAll('input[type="checkbox"]').forEach((c, j) => {
          state[j] = c.checked;
        });
        localStorage.setItem(key, JSON.stringify(state));
      });
    });
  }

  initChecklist('trackingChecklist');
  initChecklist('shoppingList');

  // Reset tracking checklist
  const resetBtn = document.getElementById('resetTracking');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const list = document.getElementById('trackingChecklist');
      if (list) {
        list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      }
      localStorage.removeItem('fembody_trackingChecklist');
      showToast('Checklist reset');
    });
  }

  // Copy shopping list
  const copyBtn = document.getElementById('copyList');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const shoppingContainer = document.getElementById('shoppingList');
      if (!shoppingContainer) return;
      
      let textToCopy = "Simple Weekly Meal Plan - Grocery List\n\n";
      const categories = shoppingContainer.querySelectorAll('.grocery-category');
      
      if (categories.length > 0) {
        categories.forEach(cat => {
          const title = cat.querySelector('h4')?.textContent || '';
          textToCopy += `${title}:\n`;
          cat.querySelectorAll('label').forEach(l => {
            textToCopy += ` • ${l.textContent.trim()}\n`;
          });
          textToCopy += '\n';
        });
      } else {
        const items = [...shoppingContainer.querySelectorAll('label')]
          .map(l => `• ${l.textContent.trim()}`)
          .join('\n');
        textToCopy += items;
      }

      navigator.clipboard.writeText(textToCopy.trim()).then(() => showToast('Shopping list copied to clipboard!'));
    });
  }

  // Toast
  function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }
});
