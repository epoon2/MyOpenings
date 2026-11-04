/*
  THE SIGNED-IN ACCOUNT, ON THIS DEVICE

  Both pages - the home page and a calendar - need the same thing: the
  session token the server handed out at sign-in, kept on the device
  and sent with every request. It lives in localStorage ("keep me
  signed in") or sessionStorage (this tab only), never both, and is
  dropped the moment it is found to be expired.

  Loaded before app.js and by the home page, as window.CalendarSession.
*/
(function () {

  var KEY =
    'calendarSession';

  function parse(
    raw
  ) {
    try {
      var saved =
        JSON.parse( raw );
      if (
        !saved ||
        typeof saved.token !== 'string' ||
        ( saved.expiresAt && new Date( saved.expiresAt ).getTime() < Date.now() )
      ) {
        return null;
      }
      return saved;
    } catch ( e ) {
      return null;
    }
  }

  function read() {
    var stores =
      [ localStorage, sessionStorage ];
    for ( var i = 0; i < stores.length; i++ ) {
      try {
        var raw =
          stores[ i ].getItem( KEY );
        if ( raw ) {
          var saved =
            parse( raw );
          if ( saved ) {
            return saved;
          }
          stores[ i ].removeItem( KEY );
        }
      } catch ( e ) {
        /* storage off: nothing remembered */
      }
    }
    return null;
  }

  function save(
    session,
    remember
  ) {
    clear();
    var record =
      JSON.stringify({
        token:
          session.token,
        expiresAt:
          session.expiresAt || null,
        slug:
          session.slug || null
      });
    try {
      ( remember ? localStorage : sessionStorage ).setItem( KEY, record );
    } catch ( e ) {
      /* private mode: signed in for this page only */
    }
  }

  function clear() {
    try {
      localStorage.removeItem( KEY );
    } catch ( e ) {}
    try {
      sessionStorage.removeItem( KEY );
    } catch ( e ) {}
  }

  window.CalendarSession = {
    read:
      read,
    save:
      save,
    clear:
      clear
  };

})();
