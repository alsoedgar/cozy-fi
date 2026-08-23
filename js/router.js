// Cozy-Fi Router Module
class Router {
  constructor(navItems, mainViews, headerBar, onRouteCallback) {
    this.navItems = navItems;
    this.mainViews = mainViews;
    this.headerBar = headerBar;
    this.onRouteCallback = onRouteCallback;
    this.currentView = 'home';

    this.init();
  }

  init() {
    this.navItems.forEach(item => {
      if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const viewId = item.getAttribute('data-view');
        this.navigate(viewId);
      });
    });
  }

  navigate(viewId) {
    this.currentView = viewId;

    // Toggle nav active state
    this.navItems.forEach(nav => {
      if (nav.getAttribute('data-view') === viewId) {
        nav.classList.add('active');
        nav.setAttribute('aria-current', 'page');
      } else {
        nav.classList.remove('active');
        nav.removeAttribute('aria-current');
      }
    });

    // Toggle view elements
    this.mainViews.forEach(view => {
      if (view.id === `view-${viewId}`) {
        view.classList.add('active');
      } else {
        view.classList.remove('active');
      }
    });

    // Header bar should only display in Search View
    if (viewId === 'search') {
      this.headerBar.style.display = 'flex';
    } else {
      this.headerBar.style.display = 'none';
    }

    if (this.onRouteCallback) {
      this.onRouteCallback(viewId);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Router;
} else {
  window.Router = Router;
}
