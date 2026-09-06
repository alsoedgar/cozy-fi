// Network availability is independent from Spotify login and playback capability.
(function () {
  let reachable = null;
  let systemOnline = true;
  const isOnline = () => navigator.onLine && systemOnline;
  function render() {
    const online = isOnline();
    const label = !online ? 'OFFLINE' : reachable === false ? 'SPOTIFY UNREACHABLE' : 'ONLINE';
    document.body.classList.toggle('is-offline', !online);
    document.querySelectorAll('[data-network-status]').forEach(element => {
      element.textContent = label;
      element.dataset.state = !online ? 'offline' : reachable === false ? 'unreachable' : 'online';
      element.title = !online ? 'Reconnect to stream music or search. Your queue and settings are kept.'
        : reachable === false ? 'Your network is connected, but Spotify could not be reached. Retrying automatically.'
          : 'Network connected';
    });
    window.dispatchEvent(new CustomEvent('cozy-network-changed', { detail: { online, reachable } }));
  }
  window.CozyNetwork = { get online() { return isOnline(); }, render };
  window.addEventListener('offline', render);
  window.addEventListener('online', () => {
    systemOnline = true;
    reachable = null;
    render();
    window.cozyApi?.network?.reconnect().catch(() => {});
  });
  document.addEventListener('DOMContentLoaded', () => {
    render();
    const accept = status => {
      const wasOnline = systemOnline;
      systemOnline = status.online !== false;
      reachable = status.reachable;
      render();
      if (!wasOnline && systemOnline && navigator.onLine) window.cozyApi?.network?.reconnect().catch(() => {});
    };
    const refresh = () => window.cozyApi?.network?.getStatus().then(accept).catch(() => {});
    void refresh();
    window.cozyApi?.network?.onStatus(accept);
    const interval = setInterval(refresh, 15000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  });
})();
