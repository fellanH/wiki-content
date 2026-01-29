/**
 * Not-Wikipedia Interactive Features
 *
 * Client-side search and preview functionality powered by HTMX.
 * Works with pre-generated static index files.
 */

(function() {
  'use strict';

  // Configuration - paths are relative to document root
  const BASE_PATH = getBasePath();

  function getBasePath() {
    const path = window.location.pathname;
    // If we're in a subdirectory (pages/, categories/), go up one level
    if (path.includes('/wiki/') || path.includes('/categories/')) {
      return '../';
    }
    return '';
  }

  const CONFIG = {
    searchIndexPath: BASE_PATH + 'api/search-index.json',
    fragmentsPath: BASE_PATH + 'fragments/',
    randomPath: BASE_PATH + 'api/random.json',
    pagesPath: BASE_PATH + 'pages/',
    debounceDelay: 200,
    maxResults: 20,
    previewDelay: 300,
  };

  // State
  let searchIndex = null;
  let searchIndexLoading = false;
  let previewTimeout = null;
  let currentPreview = null;

  /**
   * Load the search index (lazy-loaded on first search)
   */
  async function loadSearchIndex() {
    if (searchIndex) return searchIndex;
    if (searchIndexLoading) {
      // Wait for existing load
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (searchIndex) {
            clearInterval(check);
            resolve(searchIndex);
          }
        }, 50);
      });
    }

    searchIndexLoading = true;
    try {
      const response = await fetch(CONFIG.searchIndexPath);
      if (!response.ok) throw new Error('Failed to load search index');
      searchIndex = await response.json();
      return searchIndex;
    } catch (error) {
      console.error('Error loading search index:', error);
      searchIndexLoading = false;
      return [];
    }
  }

  /**
   * Search the index for matching articles
   */
  function searchArticles(query, index) {
    if (!query || query.length < 2) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return [];

    const scored = index.map(article => {
      let score = 0;

      // Title match (highest priority)
      const titleLower = article.title.toLowerCase();
      for (const term of terms) {
        if (titleLower === term) score += 100;
        else if (titleLower.startsWith(term)) score += 50;
        else if (titleLower.includes(term)) score += 20;
      }

      // Summary match
      const summaryLower = (article.summary || '').toLowerCase();
      for (const term of terms) {
        if (summaryLower.includes(term)) score += 5;
      }

      // Keyword match
      const keywords = article.keywords || [];
      for (const term of terms) {
        if (keywords.some(k => k.includes(term))) score += 10;
      }

      // Type/category match
      if (terms.includes(article.type)) score += 15;
      if (terms.includes(article.category)) score += 15;

      // Boost by inlinks (more linked = more important)
      score += Math.min(article.inlinks || 0, 10);

      return { ...article, score };
    });

    return scored
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.maxResults);
  }

  /**
   * Render search results as HTML
   */
  function renderSearchResults(results, query) {
    if (results.length === 0) {
      return `<div class="search-no-results">No articles found for "${escapeHtml(query)}"</div>`;
    }

    const items = results.map(article => {
      const typeClass = `type-${article.type || 'article'}`;
      return `
        <li class="search-result-item">
          <a href="${CONFIG.pagesPath}${article.filename}" class="search-result-link">
            <span class="search-result-title">${highlightMatch(article.title, query)}</span>
            <span class="type-badge ${typeClass}">${article.type || 'article'}</span>
          </a>
          <p class="search-result-summary">${highlightMatch(article.summary || '', query)}</p>
        </li>
      `;
    }).join('');

    return `
      <div class="search-results-header">${results.length} result${results.length === 1 ? '' : 's'}</div>
      <ul class="search-results-list">${items}</ul>
    `;
  }

  /**
   * Highlight matching terms in text
   */
  function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text);

    const escaped = escapeHtml(text);
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    let result = escaped;
    for (const term of terms) {
      const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
      result = result.replace(regex, '<mark>$1</mark>');
    }

    return result;
  }

  /**
   * Escape HTML special characters
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape regex special characters
   */
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Debounce function
   */
  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  /**
   * Handle search input
   */
  async function handleSearch(event) {
    const input = event.target;
    const query = input.value.trim();
    const resultsContainer = document.getElementById('search-results');

    if (!resultsContainer) return;

    if (query.length < 2) {
      resultsContainer.innerHTML = '';
      resultsContainer.classList.remove('active');
      return;
    }

    // Show loading state
    resultsContainer.innerHTML = '<div class="search-loading">Searching...</div>';
    resultsContainer.classList.add('active');

    try {
      const index = await loadSearchIndex();
      const results = searchArticles(query, index);
      resultsContainer.innerHTML = renderSearchResults(results, query);
    } catch (error) {
      resultsContainer.innerHTML = '<div class="search-error">Search unavailable</div>';
    }
  }

  /**
   * Show article preview on hover
   */
  async function showPreview(link, event) {
    const href = link.getAttribute('href');
    if (!href || !href.endsWith('.html')) return;

    // Extract filename
    const filename = href.split('/').pop();
    const fragmentUrl = CONFIG.fragmentsPath + filename;

    // Clear any existing preview timeout
    if (previewTimeout) {
      clearTimeout(previewTimeout);
    }

    previewTimeout = setTimeout(async () => {
      try {
        const response = await fetch(fragmentUrl);
        if (!response.ok) return;

        const html = await response.text();
        showPreviewPopover(html, link, event);
      } catch (error) {
        console.error('Error loading preview:', error);
      }
    }, CONFIG.previewDelay);
  }

  /**
   * Display preview popover
   */
  function showPreviewPopover(html, link, event) {
    hidePreview();

    const popover = document.createElement('div');
    popover.className = 'preview-popover';
    popover.innerHTML = html;

    document.body.appendChild(popover);
    currentPreview = popover;

    // Position the popover
    const linkRect = link.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();

    let left = linkRect.left;
    let top = linkRect.bottom + 8;

    // Adjust if overflowing right
    if (left + popoverRect.width > window.innerWidth - 20) {
      left = window.innerWidth - popoverRect.width - 20;
    }

    // Adjust if overflowing bottom
    if (top + popoverRect.height > window.innerHeight - 20) {
      top = linkRect.top - popoverRect.height - 8;
    }

    popover.style.left = `${Math.max(10, left)}px`;
    popover.style.top = `${Math.max(10, top + window.scrollY)}px`;

    // Add mouse event listeners to keep popover open when hovering over it
    popover.addEventListener('mouseenter', () => {
      clearTimeout(previewTimeout);
    });
    popover.addEventListener('mouseleave', hidePreview);
  }

  /**
   * Hide preview popover
   */
  function hidePreview() {
    if (previewTimeout) {
      clearTimeout(previewTimeout);
      previewTimeout = null;
    }

    if (currentPreview) {
      currentPreview.remove();
      currentPreview = null;
    }
  }

  /**
   * Navigate to random article
   */
  async function navigateRandom() {
    try {
      const response = await fetch(CONFIG.randomPath);
      if (!response.ok) throw new Error('Failed to load random data');

      const data = await response.json();
      const articles = data.articles;

      if (articles && articles.length > 0) {
        const random = articles[Math.floor(Math.random() * articles.length)];
        window.location.href = CONFIG.pagesPath + random.filename;
      }
    } catch (error) {
      console.error('Error navigating to random article:', error);
      // Fallback: try to get index and pick from search index
      try {
        const index = await loadSearchIndex();
        if (index.length > 0) {
          const random = index[Math.floor(Math.random() * index.length)];
          window.location.href = CONFIG.pagesPath + random.filename;
        }
      } catch {
        alert('Unable to find random article');
      }
    }
  }

  /**
   * Close search results when clicking outside
   */
  function handleClickOutside(event) {
    const searchContainer = document.querySelector('.search-container');
    const resultsContainer = document.getElementById('search-results');

    if (searchContainer && resultsContainer &&
        !searchContainer.contains(event.target)) {
      resultsContainer.classList.remove('active');
    }
  }

  /**
   * Initialize wiki features
   */
  function init() {
    // Search input handler
    const searchInput = document.getElementById('wiki-search');
    if (searchInput) {
      searchInput.addEventListener('input', debounce(handleSearch, CONFIG.debounceDelay));
      searchInput.addEventListener('focus', handleSearch);
    }

    // Click outside to close search
    document.addEventListener('click', handleClickOutside);

    // Preview handlers for internal links
    document.addEventListener('mouseenter', (event) => {
      const link = event.target.closest('a[href$=".html"]');
      if (link && !link.closest('.preview-popover')) {
        showPreview(link, event);
      }
    }, true);

    document.addEventListener('mouseleave', (event) => {
      const link = event.target.closest('a[href$=".html"]');
      if (link) {
        // Small delay before hiding to allow moving to popover
        setTimeout(() => {
          if (!document.querySelector('.preview-popover:hover')) {
            hidePreview();
          }
        }, 100);
      }
    }, true);

    // Random article button
    const randomBtn = document.getElementById('random-article-btn');
    if (randomBtn) {
      randomBtn.addEventListener('click', (e) => {
        e.preventDefault();
        navigateRandom();
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (event) => {
      // Escape closes search/preview
      if (event.key === 'Escape') {
        hidePreview();
        const results = document.getElementById('search-results');
        if (results) results.classList.remove('active');
      }

      // Ctrl/Cmd + K focuses search
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        const searchInput = document.getElementById('wiki-search');
        if (searchInput) searchInput.focus();
      }
    });

    console.log('Not-Wikipedia initialized');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for external use
  window.NotWikipedia = {
    search: searchArticles,
    loadIndex: loadSearchIndex,
    navigateRandom,
  };
})();
