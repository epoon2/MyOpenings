(() => {

  /*
    A built-in category beside the owner's own: the session stays on
    the calendar, but the weekly summary leaves it out of its count.
    Named categories get hex ids, so this never clashes with one.
  */
  const OMITTED =
    'omitted';


  const state = {

    view:
      'week',

    /*
      The editor's color swatch: what is picked now, and what the
      editor opened with, so a save knows whether it was touched.
    */
    editorColor:
      null,
    editorColorLoaded:
      null,

    /*
      Custom colours used before, most recent first, served with
      every admin load so they are presets on any device.
    */
    customColors:
      [],

    /*
      The kinds of booked time the owner counts apart - {id, name} -
      and the copy of that list being edited in Settings.
    */
    categories:
      [],
    settingsCategories:
      null,

    /*
      Which category the weekly summary's rows are narrowed to:
      'all', a category id, 'none' for the uncategorized, or
      OMITTED for the sessions left out of the count.
    */
    summaryCategory:
      'all',

    /*
      The two default colours being edited in the settings dialog.
    */
    settingsColors:
      null,

    /*
      The failed-email notice: which failure is on screen, and which
      one the admin dismissed, so it does not come straight back.
    */
    shownMailError:
      null,
    dismissedMailError:
      null,

    /*
      Set just below: startOfWeek reads the settings, which live here.
    */
    weekStart:
      null,

    adminPassword:
      '',

    isAdmin:
      false,

    /*
      The signed-in account, if any: the session token this device
      holds, and what the server said about the account. The calendar
      on screen is named by the address in the page's own URL.
    */
    session:
      null,

    account:
      null,

    calendarSlug:
      slugFromLocation(),

    /*
      What the server said about the calendar itself: its address,
      and whether an account owns it yet.
    */
    calendar:
      null,

    /*
      The account's other calendars (from /me), which of them are
      drawn over this one, and who owns each borrowed event id, so a
      write to it goes to the right calendar.
    */
    myCalendars:
      [],

    overlays:
      {},

    overlayOwner:
      {},


    /*
      Which segmented time control has its
      quarter-hour list open, so a click
      elsewhere can close it.
    */

    openTimeWheel:
      null,


    /*
      The session most recently copied from
      the right-click menu, waiting to be
      pasted into a slot.
    */

    clipboardEvent:
      null,


    /*
      The open right-click menu, and the flag
      that stops the click ending a drag from
      being read as a new-session click.
    */

    openContextMenu:
      null,

    suppressNextScheduleClick:
      false,

    events:
      [],

    config: {

      portalTitle:
        "Ethan's Tutoring Availability",

      tutorName:
        'Ethan',

      timezoneLabel:
        'Pacific Time (PT)',

      timezoneId:
        'America/Los_Angeles',

      dayStart:
        8,

      dayEnd:
        24
    },

    draggingId:
      null,

    pendingConflictEvent:
      null,

    /*
      Timestamp of the last public
      revalidation, used to rate limit
      the refresh below.
    */
    lastRefresh:
      0,

    /*
      Quarter-hour mark the loaded data was
      clipped to, so a stale page can be
      recognised without asking the server.
    */
    quarterMark:
      currentQuarterMark(),

    /*
      Public schedule by date, so retyping
      a time does not refetch the day it
      falls on.
    */
    scheduleByDate:
      new Map(),

    /*
      Set while the editor holds an accepted
      request, so saving can clear it from
      the queue and cancelling cannot.
    */
    acceptedRequestId:
      null,

    /*
      When this page last heard from the
      server, which is a different question
      from when the tutor last changed
      anything.
    */
    lastLoadedAt:
      0
  };


  state.weekStart =
    startOfWeek(
      new Date()
    );


  /*
    A translated string, for what visitors read.
  */
  const t =
    (key, vars) =>
      window.I18N.t( key, vars );


  /*
    Public pages revalidate at most this
    often. The server tags the public
    response for the CDN and a write
    purges that tag, so refreshing faster
    than this does not make the page
    fresher, it only spends function
    invocations.

    The one exception is the quarter-hour
    mark the schedule is clipped to. When
    that moves, the page really is showing
    times that have passed, so the check
    below overrides this limit.
  */

  const REFRESH_INTERVAL_MS =
    5 * 60 * 1000;

  const $ =
    (id) =>
      document.getElementById(
        id
      );

  const calendar =
    $('calendar');


  const agenda =
    $('agenda');



  /* =========================================================
     INITIALIZATION
  ========================================================= */


  function init() {

    bindButtons();

    resumeRememberedDevice();

    installManifest();

    initLanguage();

    loadWeek();


    /*
      Check often, act rarely. The
      guard inside maybeRefresh is what
      actually decides.
    */

    setInterval(
      () => {

        renderCheckedLabel();

        maybeRefresh();

      },
      60000
    );


    /*
      Coming back to the tab is the
      moment a stale page is actually
      noticed, so revalidate then too.
    */

    document.addEventListener(
      'visibilitychange',
      () => {

        renderCheckedLabel();

        maybeRefresh();

      }
    );


    /*
      One dismissal path for both overlays.
      A pointer down anywhere that is not the
      menu or the open wheel closes them, and
      Escape does the same from the keyboard.
    */

    document.addEventListener(
      'pointerdown',
      (event) => {

        if (
          !event.target
            .closest( '.context-menu' )
        ) {

          closeContextMenu();

        }


        /*
          The wheel button lives inside the
          control, so a press on it reaches
          this capture handler first. Closing
          on it would undo the open that is
          about to happen, which is why the
          whole control is exempt here and the
          button toggles for itself.
        */

        if (
          !event.target
            .closest( '.datetime-time' ) &&
          !event.target
            .closest( '.time-wheel' )
        ) {

          closeTimeWheel();

        }

      },
      true
    );


    document.addEventListener(
      'keydown',
      (event) => {

        if ( event.key !== 'Escape' ) {

          return;

        }


        closeContextMenu();
        closeTimeWheel();
        closeProfileMenu();
      }
    );


    /*
      Scrolling the week would leave the menu
      anchored to a slot that has moved, so it
      closes. The time wheel does not: it is
      positioned against its own field and
      moves with it, and it scrolls itself to
      the current value as it opens - which is
      a scroll event of its own, and closing on
      that would shut the wheel in the act of
      opening it.
    */

    window.addEventListener(
      'scroll',
      (scrollEvent) => {

        if (
          scrollEvent.target &&
          scrollEvent.target.closest &&
          scrollEvent.target
            .closest( '.time-wheel' )
        ) {

          return;

        }


        closeContextMenu();

      },
      true
    );


    /*
      Keep the "now" line honest while the tab sits open.
    */

    setInterval(
      mountNowLine,
      60000
    );


    applyMobileView();

    applyView();

  }


  function maybeRefresh() {

    if (
      state.isAdmin
    ) {

      return;

    }


    if (
      document.visibilityState !==
      'visible'
    ) {

      return;

    }


    const mark =
      currentQuarterMark();


    if (
      mark ===
      state.quarterMark &&
      Date.now() -
      state.lastRefresh <
      REFRESH_INTERVAL_MS
    ) {

      return;

    }


    state.quarterMark =
      mark;


    state.lastRefresh =
      Date.now();


    loadWeek(
      true
    );

  }


  /*
    The public schedule is clipped to the
    next quarter-hour mark, so that mark is
    what decides whether the page is still
    accurate. Reading it from the clock
    rather than from the response lets an
    open tab notice it has gone stale
    without spending a request to find out.
  */

  function currentQuarterMark() {

    return Math.floor(
      Date.now() /
      (
        15 *
        60 *
        1000
      )
    );

  }



  /* =========================================================
     EVENT LISTENERS
  ========================================================= */


  function bindButtons() {

    const stepAnchor =
      (direction) => {

        state.weekStart =
          state.view === 'day'
            ? addDays(
                state.weekStart,
                direction
              )
            : state.view === 'month'
              ? addMonthsToDate(
                  state.weekStart,
                  direction
                )
              : addDays(
                  state.weekStart,
                  direction *
                  7
                );

        loadWeek();

      };


    $('prevWeekBtn')
      .addEventListener(
        'click',
        () => {

          stepAnchor( -1 );

        }
      );


    $('saveWeekBtn')
      .addEventListener(
        'click',
        () => {

          downloadWeekImage();

        }
      );


    $('viewDayBtn')
      .addEventListener(
        'click',
        () => {

          switchView( 'day' );

        }
      );


    $('viewWeekBtn')
      .addEventListener(
        'click',
        () => {

          switchView( 'week' );

        }
      );


    $('viewMonthBtn')
      .addEventListener(
        'click',
        () => {

          switchView( 'month' );

        }
      );


    $('viewGridBtn')
      .addEventListener(
        'click',
        () => {

          applyMobileView( 'grid' );

        }
      );


    $('viewListBtn')
      .addEventListener(
        'click',
        () => {

          applyMobileView( 'list' );

        }
      );


    $('nextWeekBtn')
      .addEventListener(
        'click',
        () => {

          stepAnchor( 1 );

        }
      );


    $('todayBtn')
      .addEventListener(
        'click',
        () => {

          const now =
            new Date();

          now.setHours( 0, 0, 0, 0 );


          state.weekStart =
            state.view === 'day'
              ? now
              : state.view === 'month'
                ? firstOfMonth( now )
                : startOfWeek( now );

          loadWeek();

        }
      );


    $('refreshBtn')
      .addEventListener(
        'click',
        () =>
          loadWeek()
      );


    $('adminBtn')
      .addEventListener(
        'click',
        () => {

          const token =
            rememberedDeviceToken();


          if ( token ) {

            state.adminToken =
              token;

            state.isAdmin =
              true;

            loadWeek();

            return;

          }


          if ( ownsThisCalendar() ) {

            state.preview =
              false;

            state.isAdmin =
              true;

            loadWeek();

            return;

          }


          openAdminLogin();

        }
      );


    $('signOutBtn')
      .addEventListener(
        'click',
        () => {
          closeProfileMenu();
          signOut();
        }
      );
    $('legacyLoginLink')
      .addEventListener(
        'click',
        () => {
          setLoginMode( state.loginMode === 'legacy' ? 'account' : 'legacy' );
          setTimeout(
            () => {
              $( state.loginMode === 'legacy' ? 'adminPasswordInput' : 'loginEmailInput' ).focus();
            },
            30
          );
        }
      );
    $('resendVerifyBtn')
      .addEventListener(
        'click',
        resendVerification
      );
    $('changePasswordBtn')
      .addEventListener(
        'click',
        () => {
          closeProfileMenu();
          openChangePassword();
        }
      );
    $('calendarsBtn')
      .addEventListener(
        'click',
        () => {
          const body =
            document.querySelector( '.calendar-body' );
          const open =
            body.classList.toggle( 'panel-open' );
          $('calendarsBtn').setAttribute( 'aria-expanded', open ? 'true' : 'false' );
        }
      );
    document.addEventListener(
      'click',
      () => {
        closeToolsMenu();
      }
    );
    $('savePasswordBtn')
      .addEventListener(
        'click',
        savePassword
      );
    $('newPasswordAgainInput')
      .addEventListener(
        'keydown',
        (keyEvent) => {
          if ( keyEvent.key === 'Enter' ) {
            savePassword();
          }
        }
      );
    $('settingPreset')
      .addEventListener(
        'change',
        () => {
          const preset =
            WORDING_PRESETS[ $('settingPreset').value ];
          if ( !preset ) {
            return;
          }
          $('settingLabelAvailable').value = preset.available;
          $('settingLabelBlocked').value = preset.blocked;
          $('settingLabelPerson').value = preset.person;
          $('settingLabelPeople').value = preset.people;
        }
      );
    $('settingSlug')
      .addEventListener(
        'input',
        () => {
          renderShareLink( $('settingSlug').value.trim().toLowerCase() );
        }
      );
    [ [ 'copyShareLinkBtn', 'shareLink' ], [ 'copyFeedLinkBtn', 'feedLink' ] ]
      .forEach(
        ([ buttonId, textId ]) => {
          $(buttonId)
            .addEventListener(
              'click',
              async () => {
                try {
                  await navigator.clipboard.writeText( $(textId).textContent );
                  $(buttonId).textContent = t( 'copied' );
                  setTimeout( () => { $(buttonId).textContent = t( 'copy' ); }, 1500 );
                } catch (e) {
                  setStatus( t( 'copy_by_selecting' ) );
                }
              }
            );
        }
      );
    $('backToAdminBtn')
      .addEventListener(
        'click',
        () => {
          if ( !state.isAdmin ) {
            $('adminBtn').click();
          }
        }
      );
    $('profileBtn')
      .addEventListener(
        'click',
        (clickEvent) => {
          clickEvent.stopPropagation();
          toggleProfileMenu();
        }
      );
    $('themeBtn')
      .addEventListener(
        'click',
        toggleTheme
      );
    renderThemeButton();
    /*
      A device that follows its own preference redraws when that
      preference changes underneath the page.
    */
    if ( window.matchMedia ) {
      window
        .matchMedia( '(prefers-color-scheme: dark)' )
        .addEventListener(
          'change',
          () => {
            if ( !document.documentElement.getAttribute( 'data-theme' ) ) {
              renderThemeButton();
              applyConfigStyling();
              renderAll();
            }
          }
        );
    }
    /*
      The gear menu: any choice closes it, as does a click elsewhere.
    */
    $('gearBtn')
      .addEventListener(
        'click',
        (clickEvent) => {
          clickEvent.stopPropagation();
          toggleToolsMenu();
        }
      );
    [ 'undoBtn', 'redoBtn', 'historyBtn', 'settingsBtn' ]
      .forEach(
        (id) => {
          $(id)
            .addEventListener(
              'click',
              closeToolsMenu
            );
        }
      );
    document.addEventListener(
      'click',
      (clickEvent) => {
        if (
          !clickEvent.target.closest ||
          !clickEvent.target.closest( '#profileMenu' )
        ) {
          closeProfileMenu();
        }
      }
    );


    $('exitAdminBtn')
      .addEventListener(
        'click',
        () => {
          if ( state.isAdmin ) {
            exitAdmin();
          }
        }
      );


    $('addBtn')
      .addEventListener(
        'click',
        () =>
          openEventModal()
      );


    $('blockedSessionsBtn')
      .addEventListener(
        'click',
        openBlockedSessions
      );


    $('googleSyncBtn')
      .addEventListener(
        'click',
        resyncGoogleCalendar
      );


    $('undoBtn')
      .addEventListener(
        'click',
        () =>
          undoOrRedo( 'undo' )
      );


    $('redoBtn')
      .addEventListener(
        'click',
        () =>
          undoOrRedo( 'redo' )
      );


    document.addEventListener(
      'keydown',
      handleUndoKeys
    );


    $('historyBtn')
      .addEventListener(
        'click',
        openHistory
      );
    $('settingsBtn')
      .addEventListener(
        'click',
        openSettings
      );
    $('addCategoryBtn')
      .addEventListener(
        'click',
        addCategoryRow
      );
    $('saveSettingsBtn')
      .addEventListener(
        'click',
        saveSettings
      );
    $('testMailBtn')
      .addEventListener(
        'click',
        sendTestMail
      );
    $('mailNoticeSettingsBtn')
      .addEventListener(
        'click',
        () => {
          hideMailNotice();
          openSettings();
        }
      );
    $('mailNoticeCloseBtn')
      .addEventListener(
        'click',
        hideMailNotice
      );


    $('closeHistoryDrawerBtn')
      .addEventListener(
        'click',
        closeHistory
      );


    $('historyDrawerBackdrop')
      .addEventListener(
        'click',
        (event) => {

          if (
            event.target ===
            $('historyDrawerBackdrop')
          ) {

            closeHistory();

          }

        }
      );


    $('syncNoticeRetryBtn')
      .addEventListener(
        'click',
        resyncGoogleCalendar
      );


    $('syncNoticeCloseBtn')
      .addEventListener(
        'click',
        hideSyncNotice
      );


    $('requestBtn')
      .addEventListener(
        'click',
        openRequestModal
      );


    $('requestsBtn')
      .addEventListener(
        'click',
        openRequestDrawer
      );


    $('closeRequestDrawerBtn')
      .addEventListener(
        'click',
        closeRequestDrawer
      );


    $('requestDrawerBackdrop')
      .addEventListener(
        'click',
        (event) => {

          if (
            event.target ===
            $('requestDrawerBackdrop')
          ) {

            closeRequestDrawer();

          }

        }
      );


    $('sendRequestBtn')
      .addEventListener(
        'click',
        () =>
          sendRequest(
            false
          )
      );


    $('sendRequestAnywayBtn')
      .addEventListener(
        'click',
        () =>
          sendRequest(
            true
          )
      );


    /*
      Re-check as the times change, so the
      warning appears while it can still be
      acted on rather than after sending.
    */

    [
      'requestStart',
      'requestEnd'
    ]
      .forEach(
        (id) => {

          $(id)
            .addEventListener(
              'change',
              checkRequestedTime
            );

        }
      );


    $('closeBlockedDrawerBtn')
      .addEventListener(
        'click',
        closeBlockedSessions
      );


    $('blockedDrawerBackdrop')
      .addEventListener(
        'click',
        (event) => {

          if (
            event.target ===
            $('blockedDrawerBackdrop')
          ) {

            closeBlockedSessions();

          }

        }
      );


    $('loginSubmitBtn')
      .addEventListener(
        'click',
        submitAdminLogin
      );


    $('adminPasswordInput')
      .addEventListener(
        'keydown',
        (event) => {

          if (
            event.key ===
            'Enter'
          ) {

            submitAdminLogin();

          }

        }
      );


    $('summaryToggle')
      .addEventListener(
        'click',
        () => {

          const list =
            $('summaryList');


          const nowHidden =
            list
              .classList
              .toggle( 'hidden' );


          $('summaryToggleLabel')
            .textContent =
              t( nowHidden ? 'show_all' : 'hide_all', { noun: peopleWord( 2 ) } );


          $('summaryToggle')
            .setAttribute(
              'aria-expanded',
              String( !nowHidden )
            );

        }
      );


    $('saveEventBtn')
      .addEventListener(
        'click',
        saveEventFromModal
      );


    $('saveAnywayBtn')
      .addEventListener(
        'click',
        saveAnywayFromConflict
      );


    $('deleteEventBtn')
      .addEventListener(
        'click',
        deleteEventFromModal
      );


    [
      'eventStart',
      'eventEnd',
      'requestStart',
      'requestEnd'
    ]
      .forEach(
        bindDateTimeField
      );


    /*
      Weekly options, in both forms that
      offer them.
    */

    bindRecurrenceControls(
      $('eventModal'),
      clearConflictWarning
    );


    bindRecurrenceControls(
      $('requestModal')
    );


    /*
      Any edit invalidates an old
      conflict warning.
    */

    [
      'eventType',
      'eventStart',
      'eventEnd',
      'eventTitle',
      'eventNotes',
      'repeatInterval',
      'repeatEndDate',
      'repeatCount'
    ]
      .forEach(
        (id) => {
          $(id)
            .addEventListener(
              'input',
              clearConflictWarning
            );
          $(id)
            .addEventListener(
              'change',
              clearConflictWarning
            );
        }
      );
    /*
      The Default swatch shows the color the type would get.
    */
    $('eventType')
      .addEventListener(
        'change',
        () => {
          renderEditorColorRow(
            $('eventType').value
          );
          syncGoogleTitleField();
          syncCategoryField();
        }
      );


    /*
      Standard modal close buttons.
    */

    document
      .querySelectorAll(
        '[data-close]'
      )
      .forEach(
        (button) => {

          button.addEventListener(
            'click',
            () => {

              closeModal(
                button.dataset.close
              );

            }
          );

        }
      );


    /*
      Click outside modal.
    */

    document
      .querySelectorAll(
        '.modal-backdrop'
      )
      .forEach(
        (backdrop) => {

          backdrop.addEventListener(
            'click',
            (event) => {

              if (
                event.target ===
                backdrop
              ) {

                closeModal(
                  backdrop.id
                );

              }

            }
          );

        }
      );

  }



  /* =========================================================
     API
  ========================================================= */


  async function api(
    path,
    options = {}
  ) {

    const headers =
      new Headers(
        options.headers ||
        {}
      );


    if (
      state.isAdmin &&
      state.adminPassword
    ) {

      headers.set(
        'x-admin-password',
        state.adminPassword
      );

    } else if (
      state.isAdmin &&
      state.session
    ) {

      headers.set(
        'x-session',
        state.session.token
      );

    } else if (
      state.isAdmin &&
      state.adminToken
    ) {

      headers.set(
        'x-admin-token',
        state.adminToken
      );

    } else if (
      state.session
    ) {

      /*
        A visitor who is signed in elsewhere: the server tells the
        page whose account this is, so the chip can offer the way to
        their own calendar.
      */
      headers.set(
        'x-session',
        state.session.token
      );

    }


    if (
      options.body &&
      !headers.has(
        'Content-Type'
      )
    ) {

      headers.set(
        'Content-Type',
        'application/json'
      );

    }


    /*
      Every write to the schedule names the user action it belongs
      to, so the server records one undo step per gesture rather
      than one per request. Reading the schedule back marks the end
      of the gesture.
    */

    const method =
      String(
        options.method ||
        'GET'
      ).toUpperCase();


    if (
      path.startsWith( '/events' ) ||
      path === '/history/restore' ||
      path === '/history/restoreversion'
    ) {

      if ( method === 'GET' ) {

        endAction();

      } else {

        if ( !state.action ) {

          beginAction(
            describeWrite(
              path,
              method,
              options.body
            )
          );

        }


        headers.set(
          'x-action-id',
          state.action.id
        );


        headers.set(
          'x-action-label',
          state.action.label
        );


        armActionTimer();

      }

    }


    /*
      Every request names the calendar the page is showing; with no
      address in the URL it is the first calendar. A write to an event
      borrowed from another of the owner's calendars goes to that
      calendar instead.
    */
    const target =
      overlayCalendarFor( path, method, options.body ) ||
      state.calendarSlug;
    if ( target ) {
      path +=
        ( path.includes( '?' ) ? '&' : '?' ) +
        'calendar=' +
        encodeURIComponent( target );
    }
    if ( state.preview && !state.isAdmin && method === 'GET' ) {
      path +=
        ( path.includes( '?' ) ? '&' : '?' ) +
        'preview=1';
    }


    const response =
      await fetch(
        '/api' +
        path,
        {
          ...options,

          headers,

          cache:
            'no-store'
        }
      );


    const data =
      await response
        .json()
        .catch(
          () => ({})
        );


    if (
      !response.ok
    ) {

      const error =
        new Error(
          data.error ||
          `Request failed (${response.status})`
        );


      error.status =
        response.status;


      error.data =
        data;


      throw error;

    }


    /*
      A change that reached the portal but not Google Calendar comes
      back with sync.google === 'failed'. The change stands; the page
      says so once, with a way to push everything again.
    */

    noteGoogleSync(
      data.sync
    );


    return data;

  }



  /* =========================================================
     UNDO / REDO
  ========================================================= */

  /*
    A gesture on the page - a save, a drag, a scoped delete - can be
    several requests. They share one action id, so the server keeps
    a single snapshot for the lot and Undo puts the whole gesture
    back. The action ends when the schedule is reloaded, when the
    editor opens, or after a few idle seconds.
  */

  function beginAction(
    label
  ) {

    state.action = {
      id:
        newActionId(),

      label:
        label ||
        'change'
    };


    armActionTimer();

  }


  function endAction() {

    state.action =
      null;


    if ( state.actionTimer ) {

      clearTimeout(
        state.actionTimer
      );


      state.actionTimer =
        null;

    }

  }


  function armActionTimer() {

    if ( state.actionTimer ) {

      clearTimeout(
        state.actionTimer
      );

    }


    state.actionTimer =
      setTimeout(
        endAction,
        5000
      );

  }


  function newActionId() {

    if (
      window.crypto &&
      typeof window.crypto.randomUUID === 'function'
    ) {

      return window.crypto.randomUUID();

    }


    return String( Date.now() ) +
      Math.random()
        .toString( 16 )
        .slice( 2 );

  }


  /*
    A label for a write nobody named first.
  */

  function describeWrite(
    path,
    method,
    body
  ) {

    if ( path.endsWith( '/skip' ) ) {

      return 'skip a week';

    }


    if ( method === 'DELETE' ) {

      return 'delete session';

    }


    try {

      const parsed =
        JSON.parse(
          body ||
          '{}'
        );


      const noun =
        parsed.type === 'AVAILABLE'
          ? 'availability'
          : 'session';


      return parsed.id
        ? `edit ${noun}`
        : `add ${noun}`;

    } catch {

      return 'change';

    }

  }


  function applyHistory(
    history
  ) {

    state.history =
      history ||
      {
        undo: 0,
        redo: 0,
        undoLabel: null,
        redoLabel: null
      };


    renderUndoButtons();

  }


  function renderUndoButtons() {

    const history =
      state.history ||
      {};


    const undoBtn =
      $('undoBtn');


    const redoBtn =
      $('redoBtn');


    undoBtn.disabled =
      !history.undo;


    redoBtn.disabled =
      !history.redo;


    undoBtn.title =
      history.undo
        ? t( 'undo_label', { label: history.undoLabel } )
        : t( 'nothing_to_undo' );


    redoBtn.title =
      history.redo
        ? t( 'redo_label', { label: history.redoLabel } )
        : t( 'nothing_to_redo' );

  }


  async function undoOrRedo(
    which
  ) {

    if (
      !state.isAdmin ||
      state.historyBusy
    ) {

      return;

    }


    const history =
      state.history ||
      {};


    if (
      which === 'undo'
        ? !history.undo
        : !history.redo
    ) {

      return;

    }


    state.historyBusy =
      true;


    endAction();


    try {

      const result =
        await api(
          `/${which}`,
          {
            method:
              'POST',

            body:
              '{}'
          }
        );


      await loadWeek(
        true
      );


      if (
        !$('historyDrawerBackdrop')
          .classList
          .contains( 'hidden' )
      ) {

        await refreshHistory();

      }


      const entry =
        result.undone ||
        result.redone;


      setStatus(
        t( which === 'undo' ? 'undid' : 'redid', { label: entry ? entry.label : t( 'change' ) } )
      );

    } catch (error) {

      handleError(
        error
      );

    } finally {

      state.historyBusy =
        false;

    }

  }


  /*
    Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) while nothing is being typed
    and no dialog is open. Inside a text field the browser's own
    undo keeps its meaning.
  */

  function handleUndoKeys(
    event
  ) {

    if (
      !state.isAdmin ||
      !(
        event.ctrlKey ||
        event.metaKey
      ) ||
      event.altKey
    ) {

      return;

    }


    const key =
      event.key.toLowerCase();


    const isUndo =
      key === 'z' &&
      !event.shiftKey;


    const isRedo =
      (
        key === 'z' &&
        event.shiftKey
      ) ||
      key === 'y';


    if (
      !isUndo &&
      !isRedo
    ) {

      return;

    }


    const target =
      event.target;


    if (
      target &&
      (
        target.isContentEditable ||
        [ 'INPUT', 'TEXTAREA', 'SELECT' ]
          .includes( target.tagName )
      )
    ) {

      return;

    }


    if (
      document.querySelector(
        '.modal-backdrop:not(.hidden), .choice-modal'
      )
    ) {

      return;

    }


    event.preventDefault();


    undoOrRedo(
      isUndo
        ? 'undo'
        : 'redo'
    );

  }



  /* =========================================================
     HISTORY DRAWER
  ========================================================= */

  /*
    The undo stack as a list the admin can read: each step with the
    sessions it added, removed or changed, "Undo to here" on any of
    them, and "Restore" beside anything a step removed - which puts
    just that session back, as a fresh change, without touching what
    happened since.
  */

  async function openHistory() {

    if ( !state.isAdmin ) {

      return;

    }


    $('historyDrawerBackdrop')
      .classList
      .remove(
        'hidden'
      );


    await refreshHistory();

  }


  function closeHistory() {

    $('historyDrawerBackdrop')
      .classList
      .add(
        'hidden'
      );

  }


  async function refreshHistory() {

    $('historyStatus')
      .textContent =
        'Loading…';


    try {

      const data =
        await api(
          '/history'
        );


      renderHistory(
        data
      );


      $('historyStatus')
        .textContent =
          '';

    } catch (error) {

      $('historyStatus')
        .textContent =
          error.message;

    }

  }


  /*
    Versions, newest first, the way a spreadsheet's history reads:
    the top row is the schedule as it is now; each row below is the
    schedule as it stood at an earlier save, stamped with when that
    save happened and what it changed. "Restore this version" makes
    that schedule current again as a new change on top - nothing is
    unwound, and the restore is itself in the list afterwards.

    The server hands over the undo stack: each step with the schedule
    as it was BEFORE it and the change it made. A version is the state
    after a step, which is the next step's before-state, or the
    current schedule at the top.
  */

  function renderHistory(
    data
  ) {

    const list =
      $('historyList');


    list.innerHTML =
      '';


    const steps =
      data.undo ||
      [];


    if ( !steps.length ) {

      const empty =
        document.createElement(
          'div'
        );


      empty.className =
        'history-empty';


      empty.textContent =
        t( 'only_current' );


      list.appendChild(
        empty
      );


      return;

    }


    /*
      Row 0: the current schedule, produced by the newest step.
      Row j (1 ..): the schedule before step j-1, produced by step j.
      Last row: the schedule before the oldest recorded step.
    */

    steps.forEach(
      (step, index) => {

        list.appendChild(
          renderVersion({
            current:
              index === 0,

            producedBy:
              step,

            restoreId:
              index === 0
                ? null
                : steps[ index - 1 ].id
          })
        );

      }
    );


    const oldest =
      steps[ steps.length - 1 ];


    list.appendChild(
      renderVersion({
        current:
          false,

        producedBy:
          null,

        restoreId:
          oldest.id
      })
    );

  }


  function renderVersion({
    current,
    producedBy,
    restoreId
  }) {

    const row =
      document.createElement(
        'div'
      );


    row.className =
      'history-step' +
      (
        current
          ? ' current'
          : ''
      );


    if ( restoreId ) {

      row.dataset.versionId =
        restoreId;

    }


    const head =
      document.createElement(
        'div'
      );


    head.className =
      'history-step-head';


    const when =
      document.createElement(
        'div'
      );


    when.className =
      'history-step-label';


    when.textContent =
      current
        ? t( 'current_version' )
        : producedBy
          ? formatVersionTime(
              producedBy.at
            )
          : t( 'before_history' );


    const label =
      document.createElement(
        'div'
      );


    label.className =
      'history-step-when';


    label.textContent =
      producedBy
        ? capitalize(
            producedBy.label
          )
        : '';


    head.append(
      when,
      label
    );


    row.appendChild(
      head
    );


    if ( producedBy ) {

      const lines = [
        ...( producedBy.removed || [] ).map(
          (item) => [ 'removed', item ]
        ),
        ...( producedBy.added || [] ).map(
          (item) => [ 'added', item ]
        ),
        ...( producedBy.changed || [] ).map(
          (item) => [ 'changed', item ]
        )
      ];


      for (
        const [ kind, item ] of lines
      ) {

        const line =
          document.createElement(
            'div'
          );


        line.className =
          'history-change';


        const badge =
          document.createElement(
            'span'
          );


        badge.className =
          'history-change-kind ' +
          kind;


        badge.textContent =
          kind;


        const what =
          document.createElement(
            'span'
          );


        what.className =
          'history-change-what';


        what.innerHTML =
          describeBrief(
            item,
            kind
          );


        line.append(
          badge,
          what
        );


        /*
          A removed session that is not back yet can come back on
          its own, without restoring the whole version.
        */

        if (
          kind === 'removed' &&
          !item.present
        ) {

          const restore =
            document.createElement(
              'button'
            );


          restore.className =
            'text-btn history-inline-restore';


          restore.textContent =
            t( 'restore_just_this' );


          restore.title =
            t( 'restore_just_this_hint' );


          restore.addEventListener(
            'click',
            () =>
              restoreFromHistory(
                producedBy,
                item,
                restore
              )
          );


          line.appendChild(
            restore
          );

        }


        row.appendChild(
          line
        );

      }

    }


    if ( !current ) {

      const actions =
        document.createElement(
          'div'
        );


      actions.className =
        'history-step-actions';


      const restore =
        document.createElement(
          'button'
        );


      restore.className =
        'btn secondary small';


      restore.textContent =
        t( 'restore_version' );


      restore.title =
        t( 'restore_version_hint' );


      restore.addEventListener(
        'click',
        () =>
          restoreVersion(
            restoreId,
            producedBy
              ? formatVersionTime(
                  producedBy.at
                )
              : 'before recorded history',
            restore
          )
      );


      actions.appendChild(
        restore
      );


      row.appendChild(
        actions
      );

    }


    return row;

  }


  function formatVersionTime(
    iso
  ) {

    const date =
      new Date(
        iso
      );


    if (
      Number.isNaN(
        date.getTime()
      )
    ) {

      return '';

    }


    const today =
      new Date();


    const sameDay =
      date.toDateString() ===
      today.toDateString();


    const time =
      date.toLocaleTimeString(
        I18N.locale(),
        {
          hour12: !is24h(),
          hour:
            'numeric',

          minute:
            '2-digit'
        }
      );


    if ( sameDay ) {

      return t( 'today_at', { time } );

    }


    return date.toLocaleDateString(
      I18N.locale(),
      {
        month:
          'short',

        day:
          'numeric'
      }
    ) + `, ${time}`;

  }


  async function restoreVersion(
    entryId,
    whenLabel,
    button
  ) {

    if ( state.historyBusy ) {

      return;

    }


    state.historyBusy =
      true;


    button.disabled =
      true;


    beginAction(
      `restore the version from ${whenLabel}`
    );


    $('historyStatus')
      .textContent =
        'Restoring…';


    try {

      const result =
        await api(
          '/history/restoreversion',
          {
            method:
              'POST',

            body:
              JSON.stringify({
                entryId
              })
          }
        );


      await loadWeek(
        true
      );


      await refreshHistory();


      setStatus(
        result.unchanged
          ? t( 'already_current' )
          : t( 'restored_version', { when: whenLabel } )
      );


      $('historyStatus')
        .textContent =
          '';

    } catch (error) {

      button.disabled =
        false;


      $('historyStatus')
        .textContent =
          error.message;

    } finally {

      state.historyBusy =
        false;

    }

  }


  async function restoreFromHistory(
    entry,
    item,
    button
  ) {

    if ( state.historyBusy ) {

      return;

    }


    state.historyBusy =
      true;


    button.disabled =
      true;


    beginAction(
      'restore ' +
      shortTitle(
        item
      )
    );


    try {

      await api(
        '/history/restore',
        {
          method:
            'POST',

          body:
            JSON.stringify({
              entryId:
                entry.id,

              eventId:
                item.id
            })
        }
      );


      await loadWeek(
        true
      );


      await refreshHistory();


      setStatus(
        t( 'restored_item', { title: shortTitle( item ) } )
      );

    } catch (error) {

      button.disabled =
        false;


      $('historyStatus')
        .textContent =
          error.message;

    } finally {

      state.historyBusy =
        false;

    }

  }


  /*
    "Maya - Algebra II · Tue Sep 15, 4–5 PM · weekly on Tue, Thu"
  */

  function describeBrief(
    item,
    kind
  ) {

    const parts = [];


    parts.push(
      `<strong>${
        escapeHtml(
          shortTitle(
            item
          )
        )
      }</strong>`
    );


    parts.push(
      escapeHtml(
        describeWhenBlock(
          item.start,
          item.end
        )
      )
    );


    if ( item.recurrence ) {

      parts.push(
        escapeHtml(
          describeRecurrence(
            item.recurrence
          )
        )
      );

    }


    let text =
      parts.join(
        ' <span class="muted">·</span> '
      );


    if (
      kind === 'changed' &&
      item.was
    ) {

      const before = [];


      if ( item.was.title !== item.title ) {

        before.push(
          `was "${item.was.title}"`
        );

      }


      if (
        item.was.start !== item.start ||
        item.was.end !== item.end
      ) {

        before.push(
          'was ' +
          describeWhenBlock(
            item.was.start,
            item.was.end
          )
        );

      }


      if (
        item.was.recurring !==
        Boolean( item.recurrence )
      ) {

        before.push(
          item.was.recurring
            ? 'was repeating'
            : 'was one-time'
        );

      }


      if ( before.length ) {

        text +=
          ` <span class="muted">(${
            escapeHtml(
              before.join( '; ' )
            )
          })</span>`;

      }

    }


    return text;

  }


  function shortTitle(
    item
  ) {

    const title =
      (
        item.title ||
        ''
      ).trim();


    if ( title ) {

      return title.length > 40
        ? title.slice( 0, 39 ) + '…'
        : title;

    }


    return item.type === 'AVAILABLE'
      ? 'availability'
      : 'session';

  }


  function describeWhenBlock(
    start,
    end
  ) {

    const startKey =
      localDateTimeToMinuteKey(
        start
      );


    const endKey =
      localDateTimeToMinuteKey(
        end
      );


    if (
      startKey === null ||
      endKey === null
    ) {

      return '';

    }


    const day =
      new Date(
        start.slice( 0, 10 ) +
        'T12:00'
      );


    const dayLabel =
      day.toLocaleDateString(
        I18N.locale(),
        {
          weekday:
            'short',

          month:
            'short',

          day:
            'numeric'
        }
      );


    const dayStart =
      localDateTimeToMinuteKey(
        start.slice( 0, 10 ) +
        'T00:00'
      );


    return `${dayLabel}, ${
      formatMinuteRange(
        startKey - dayStart,
        endKey - dayStart
      )
    }`;

  }


  function describeRecurrence(
    recurrence
  ) {

    const names =
      [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];


    const days =
      (
        recurrence.weekdays ||
        []
      )
        .slice()
        .sort(
          (a, b) => a - b
        )
        .map(
          (d) => names[ d ]
        )
        .join( ', ' );


    const every =
      recurrence.interval > 1
        ? `every ${recurrence.interval} weeks`
        : 'weekly';


    let text =
      `${every} on ${days}`;


    if (
      recurrence.endType === 'ON' &&
      recurrence.until
    ) {

      text +=
        ` until ${recurrence.until}`;

    } else if (
      recurrence.endType === 'COUNT' &&
      recurrence.count
    ) {

      text +=
        `, ${recurrence.count} times`;

    }


    if (
      recurrence.exdates &&
      recurrence.exdates.length
    ) {

      text +=
        `, ${recurrence.exdates.length} week${
          recurrence.exdates.length === 1
            ? ''
            : 's'
        } skipped`;

    }


    return text;

  }


  function describeWhen(
    iso
  ) {

    const date =
      new Date(
        iso
      );


    if (
      Number.isNaN(
        date.getTime()
      )
    ) {

      return '';

    }


    const minutes =
      Math.round(
        (
          Date.now() -
          date.getTime()
        ) /
        60000
      );


    if ( minutes < 1 ) {

      return 'just now';

    }


    if ( minutes < 60 ) {

      return `${minutes} min ago`;

    }


    if ( minutes < 24 * 60 ) {

      const hours =
        Math.round(
          minutes / 60
        );


      return `${hours} hour${
        hours === 1
          ? ''
          : 's'
      } ago`;

    }


    return formatUpdated(
      iso
    );

  }


  function capitalize(
    text
  ) {

    const value =
      String(
        text ||
        ''
      );


    return value.charAt( 0 ).toUpperCase() +
      value.slice( 1 );

  }


  function escapeHtml(
    text
  ) {

    return String(
      text ??
      ''
    )
      .replace( /&/g, '&amp;' )
      .replace( /</g, '&lt;' )
      .replace( />/g, '&gt;' )
      .replace( /"/g, '&quot;' );

  }



  /* =========================================================
     GOOGLE CALENDAR SYNC
  ========================================================= */

  function noteGoogleSync(
    sync
  ) {

    if (
      !sync ||
      sync.google !== 'failed'
    ) {

      return;

    }


    showSyncNotice(
      t( 'saved_not_google' ) +
      (
        sync.error
          ? ` (${sync.error}).`
          : '.'
      ),
      false
    );

  }


  function showSyncNotice(
    text,
    ok
  ) {

    const notice =
      $('syncNotice');


    $('syncNoticeText')
      .textContent =
        text;


    notice
      .classList
      .toggle(
        'ok',
        Boolean( ok )
      );


    $('syncNoticeRetryBtn')
      .classList
      .toggle(
        'hidden',
        Boolean( ok )
      );


    notice
      .classList
      .remove(
        'hidden'
      );

  }


  function hideSyncNotice() {

    $('syncNotice')
      .classList
      .add(
        'hidden'
      );

  }


  /*
    Push every booked session to Google again and drop anything the
    portal put there that no longer has a session behind it.
  */

  async function resyncGoogleCalendar() {

    const button =
      $('googleSyncBtn');


    button.disabled =
      true;


    setStatus(
      t( 'syncing_google' )
    );


    try {

      const result =
        await api(
          '/google/resync',
          {
            method:
              'POST',

            body:
              '{}'
          }
        );


      if (
        result.google === 'ok'
      ) {

        showSyncNotice(
          t( 'google_up_to_date', { count: t( result.pushed === 1 ? 'sessions_n' : 'sessions_np', { n: result.pushed } ) } ) +
          (
            result.removed
              ? `, ${result.removed} stale removed.`
              : '.'
          ),
          true
        );

      } else if (
        result.google === 'off'
      ) {

        showSyncNotice(
          t( 'google_not_set_up' ),
          false
        );

      } else {

        const failed =
          (
            result.failed ||
            []
          ).length;


        showSyncNotice(
          t( 'google_did_not_finish' ) +
          (
            failed
              ? ` - ${failed} session${
                  failed === 1
                    ? ''
                    : 's'
                } failed`
              : ''
          ) +
          (
            result.error
              ? ` (${result.error}).`
              : '.'
          ),
          false
        );

      }


      setStatus(
        ''
      );

    } catch (error) {

      handleError(
        error
      );

    } finally {

      button.disabled =
        false;

    }

  }



  /* =========================================================
     LOAD WEEK
  ========================================================= */


  async function loadWeek(
    silent = false
  ) {

    if (
      !silent
    ) {

      setStatus(
        t( 'loading' )
      );

    }


    try {

      const range =
        visibleRange();


      const start =
        formatDate(
          range.start
        );


      const end =
        formatDate(
          addDays(
            range.start,
            range.days -
            1
          )
        );


      let data;
      try {
        const shown =
          state.isAdmin ? shownOverlays() : [];
        data =
          await api(
            `/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
            ( shown.length ? `&with=${ encodeURIComponent( shown.join( ',' ) ) }` : '' )
          );
      } catch (error) {
        if (
          error.status === 404 &&
          error.data &&
          ( error.data.missing || error.data.unpublished )
        ) {
          showMissingCalendar( error.data );
          return;
        }
        throw error;
      }


            state.events =
        data.events ||
        [];


      state.calendar =
        data.calendar ||
        state.calendar;
      mergeOverlays(
        data.overlays || {}
      );
      if ( data.session === 'invalid' ) {
        forgetSession();
      }
      state.account =
        data.account ||
        null;
      renderVerifyNotice();


      /*
        Merge rather than replace. A deploy
        can briefly serve this page against a
        cached response from the previous
        version, and a key that response does
        not carry should fall back to the
        built-in default rather than becoming
        undefined on screen.
      */

      state.config = {
        ...state.config,
        ...(
          data.config ||
          {}
        )
      };
      syncLanguage();
      applyConfigStyling();
      renderProfileChip();
      if (
        state.isAdmin &&
        data.mode !== 'admin' &&
        state.adminToken &&
        !state.adminPassword
      ) {

        forgetDevice();

      }


      /*
        Signed in, but this is somebody else's calendar: a visitor
        here, with a way to their own.
      */
      if (
        state.isAdmin &&
        data.mode !== 'admin' &&
        state.session
      ) {

        state.isAdmin =
          false;

      }


      state.isAdmin =
        data.mode ===
        'admin';


      applyMode();
      applyHistory(
        data.history
      );
      if ( Array.isArray( data.customColors ) ) {
        state.customColors =
          data.customColors
            .map( normalizeHex )
            .filter( Boolean );
      }
      if ( Array.isArray( data.categories ) ) {
        state.categories =
          data.categories;
      }
      applyMailStatus(
        data.mail
      );


      /*
        The version list, if it is open, follows every reload so a
        change made behind it shows up at the top.
      */

      if (
        state.isAdmin &&
        !$('historyDrawerBackdrop')
          .classList
          .contains( 'hidden' ) &&
        !state.historyBusy
      ) {

        refreshHistory();

      }

      renderAll();


      $('portalTitle')
        .textContent =
          state.config
            .portalTitle;


      document.title =
        state.config
          .portalTitle;


      $('timezoneLabel')
        .textContent =
          localizedTimezoneLabel();


            $('updatedLabel')
        .textContent =
          data.lastUpdated
            ? t( 'updated_by', { owner: state.config.tutorName, when: formatUpdated( data.lastUpdated ) } )
            : t( 'not_saved', { owner: state.config.tutorName } );


      state.lastLoadedAt =
        Date.now();


      renderCheckedLabel();


      if (
        !silent
      ) {

        setStatus(
          ''
        );

      }

    } catch (error) {

      if (
        !silent
      ) {

        handleError(
          error
        );

      }

    }

  }



  function applyMode() {

    $('adminBanner')
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );


    $('addBtn')
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );


    $('blockedSessionsBtn')
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );


    /*
      Only where the site has Google
      credentials; otherwise the button
      would do nothing.
    */

    $('googleSyncBtn')
      .classList
      .toggle(
        'hidden',
        !(
          state.isAdmin &&
          state.config.googleSync
        )
      );


    $('toolsMenuWrap')
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );
    if ( !state.isAdmin ) {
      closeToolsMenu();
    }
    /*
      Signed in is either admin mode or a remembered device looking at
      the visitor view; either way the chip stands in for the Log in
      button, and its menu offers the way across.
    */
    const signedIn =
      state.isAdmin ||
      Boolean( state.adminToken ) ||
      Boolean( state.session );
    $('profileMenu')
      .classList
      .toggle(
        'hidden',
        !signedIn
      );
    /*
      The Admin view / Public view switch sits on the calendar toolbar
      whenever there is a way back: in admin mode, or on a remembered
      device looking at the public view of its own calendar.
    */
    $('modeSwitch')
      .classList
      .toggle(
        'hidden',
        !( state.isAdmin || Boolean( state.adminToken ) || ownsThisCalendar() )
      );
    $('myCalendarLink')
      .classList
      .toggle(
        'hidden',
        !( state.session && state.account && !ownsThisCalendar() )
      );
    $('dashboardLink')
      .classList
      .toggle(
        'hidden',
        !( state.session && state.account )
      );
    $('accountsLink')
      .classList
      .toggle(
        'hidden',
        !( state.session && state.account && state.account.master )
      );
    if ( state.isAdmin && state.session ) {
      loadMyCalendars();
    }
    renderCalendarsMenu();
    if ( state.account ) {
      $('myCalendarLink').href =
        '/' + state.account.slug;
    }
    $('backToAdminBtn')
      .setAttribute( 'aria-pressed', state.isAdmin ? 'true' : 'false' );
    $('exitAdminBtn')
      .setAttribute( 'aria-pressed', state.isAdmin ? 'false' : 'true' );
    $('signOutBtn')
      .classList
      .toggle(
        'hidden',
        !signedIn
      );
    $('profileMenuMode')
      .textContent =
        state.isAdmin
          ? roleName()
          : ( ownsThisCalendar() || state.adminToken || !state.account )
            ? t( 'public_view_btn' )
            : t( 'someones_calendar' );
    /*
      Only an account has a password of its own to change.
    */
    $('changePasswordBtn')
      .classList
      .toggle(
        'hidden',
        !( state.session && state.account )
      );
    renderProfileChip();
    if ( !signedIn ) {
      closeProfileMenu();
    }


    if ( !state.isAdmin ) {

      closeHistory();

    }


    if ( !state.isAdmin ) {

      hideSyncNotice();

    }


    $('requestsBtn')
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );


    refreshRequestCount();


    $('adminBtn')
      .classList
      .toggle(
        'hidden',
        signedIn
      );
    $('requestBtn')
      .classList
      .toggle(
        'hidden',
        state.isAdmin ||
        !requestsOpen()
      );
  }


  /*
    Whether visitors may ask for a session here at all.
  */
  function requestsOpen() {
    return !state.config.requests || state.config.requests.enabled !== false;
  }


  /*
    The rules a request must meet, in one line under the form's
    introduction - only the ones that are not the defaults.
  */
  function describeRequestRules(
    rules
  ) {
    const parts =
      [];
    const length =
      (minutes) =>
        minutes % 60 === 0
          ? ( minutes / 60 === 1 ? '1 hour' : ( minutes / 60 ) + ' hours' )
          : minutes > 60
            ? Math.floor( minutes / 60 ) + ' h ' + ( minutes % 60 ) + ' min'
            : minutes + ' minutes';
    if ( rules.minNoticeHours > 0 ) {
      parts.push( 'at least ' + length( rules.minNoticeHours * 60 ) + "' notice" );
    }
    if ( rules.maxWeeksAhead && rules.maxWeeksAhead < 12 ) {
      parts.push( 'up to ' + ( rules.maxWeeksAhead === 1 ? 'one week' : rules.maxWeeksAhead + ' weeks' ) + ' ahead' );
    }
    if ( ( rules.minMinutes && rules.minMinutes > 15 ) || ( rules.maxMinutes && rules.maxMinutes < 480 ) ) {
      parts.push( 'sessions of ' + length( rules.minMinutes || 15 ) + ' to ' + length( rules.maxMinutes || 480 ) );
    }
    if ( !parts.length ) {
      return '';
    }
    return 'Requests need ' + parts.join( ', ' ) + '.';
  }

  /*
    The profile chip: the first letter of the display name in a
    circle, the name beside it. Signed-in visitors and admins alike.
  */
  function renderProfileChip() {
    const name =
      (
        ( state.account && !ownsThisCalendar() )
          ? state.account.displayName
          : state.config.tutorName || 'Admin'
      ).trim() || 'Admin';
    $('profileInitial').textContent =
      name.charAt( 0 ).toUpperCase();
    $('profileName').textContent =
      name;
    $('profileMenuName').textContent =
      name;
  }

  function toggleProfileMenu() {
    const open =
      $('profileDropdown')
        .classList
        .contains( 'hidden' );
    $('profileDropdown')
      .classList
      .toggle( 'hidden', !open );
    $('profileBtn')
      .setAttribute( 'aria-expanded', open ? 'true' : 'false' );
  }

  function closeProfileMenu() {
    $('profileDropdown')
      .classList
      .add( 'hidden' );
    $('profileBtn')
      .setAttribute( 'aria-expanded', 'false' );
  }



  /* =========================================================
     DAY / WEEK / MONTH VIEWS
  ========================================================= */

  /*
    One anchor date serves all three views: the day itself in day
    view, the week's Sunday in week view, the first of the month in
    month view. visibleRange turns it into the span to load and draw.
  */

  function firstOfMonth(
    date
  ) {

    return new Date(
      date.getFullYear(),
      date.getMonth(),
      1
    );

  }


  function addMonthsToDate(
    date,
    count
  ) {

    return new Date(
      date.getFullYear(),
      date.getMonth() +
      count,
      1
    );

  }


  function visibleRange() {

    if ( state.view === 'day' ) {

      return {
        start:
          state.weekStart,
        days:
          1
      };

    }


    if ( state.view === 'month' ) {

      return {
        start:
          startOfWeek(
            firstOfMonth(
              state.weekStart
            )
          ),
        days:
          42
      };

    }


    return {
      start:
        state.weekStart,
      days:
        7
    };

  }


  const VIEW_WORD = {
    day: 'daily',
    week: 'weekly',
    month: 'monthly'
  };


  function applyView() {

    [ 'day', 'week', 'month' ].forEach(
      (name) => {

        document.body.classList.toggle(
          'view-' + name,
          state.view ===
          name
        );


        $('view' + name.charAt( 0 ).toUpperCase() + name.slice( 1 ) + 'Btn')
          .setAttribute(
            'aria-pressed',
            String(
              state.view ===
              name
            )
          );

      }
    );


    /*
      The download icon keeps its picture; its tooltip names the view
      it will save, and the file gets the same name (see downloadName).
    */
    const saveLabel =
      t( 'screenshot_view', { view: t( 'view_' + VIEW_WORD[ state.view ] ) } );
    $('saveWeekBtn')
      .title =
        saveLabel;
    $('saveWeekBtn')
      .setAttribute( 'aria-label', saveLabel );

  }


  function switchView(
    next
  ) {

    if (
      state.view ===
      next
    ) {

      return;

    }


    /*
      Leaving week view lands on today when today is on screen -
      that is almost always the day being asked about - otherwise on
      the start of the visible span.
    */

    let anchor =
      new Date(
        state.weekStart
      );


    if ( state.view === 'week' ) {

      const today =
        new Date();

      today.setHours( 0, 0, 0, 0 );


      if (
        today >=
          state.weekStart &&
        today <=
          addDays(
            state.weekStart,
            6
          )
      ) {

        anchor =
          today;

      }

    }


    state.view =
      next;


    state.weekStart =
      next === 'week'
        ? startOfWeek( anchor )
        : next === 'month'
          ? firstOfMonth( anchor )
          : anchor;


    applyView();

    loadWeek();

  }


  function switchToDay(
    dateStr
  ) {

    const day =
      new Date(
        dateStr +
        'T12:00'
      );

    day.setHours( 0, 0, 0, 0 );


    state.view =
      'day';


    state.weekStart =
      day;


    applyView();

    loadWeek();

  }


  /*
    Phones choose between the week grid and the agenda list. Grid is
    the default; the choice sticks per device. Desktop ignores all of
    this - the toggle only renders under the mobile breakpoint.
  */

  function storedMobileView() {

    try {

      return localStorage.getItem( 'mobileView' ) === 'list'
        ? 'list'
        : 'grid';

    } catch (error) {

      return 'grid';

    }

  }


  function applyMobileView(
    next
  ) {

    if ( next ) {

      state.mobileView =
        next;


      try {

        localStorage.setItem(
          'mobileView',
          next
        );

      } catch (error) {

        /* Private windows forget; the toggle still works today. */

      }

    } else if ( !state.mobileView ) {

      state.mobileView =
        storedMobileView();

    }


    const list =
      state.mobileView ===
      'list';


    document.body.classList.toggle(
      'list-view',
      list
    );


    $('viewGridBtn')
      .setAttribute(
        'aria-pressed',
        String( !list )
      );


    $('viewListBtn')
      .setAttribute(
        'aria-pressed',
        String( list )
      );

  }


  function renderAll() {

    renderWeekLabel();

    renderCalendar();

    renderAgenda();

    renderWeekSummary();

    mountNowLine();

  }


  /*
    The red line that says "you are here". Drawn in today's column at
    the portal's own current time - getPortalNowMinuteKey, not the
    visitor's clock, so a student in another timezone sees the line
    where the tutor's day actually stands. Redrawn by renderAll and by
    a once-a-minute tick; absent entirely when the viewed week is not
    this one or the moment falls outside the visible hours.
  */

  function mountNowLine() {

    document
      .querySelectorAll( '.now-line' )
      .forEach(
        (element) => {

          element.remove();

        }
      );


    const nowLocal =
      minuteKeyToLocalDateTime(
        getPortalNowMinuteKey()
      );


    const today =
      nowLocal.slice( 0, 10 );


    const column =
      document.querySelector(
        '.day-column[data-date="' +
        today +
        '"]'
      );


    if ( !column ) {

      return;

    }


    const startHour =
      Number(
        state.config
          .dayStart ??
        8
      );


    const endHour =
      Number(
        state.config
          .dayEnd ??
        24
      );


    const minutes =
      Number( nowLocal.slice( 11, 13 ) ) *
      60 +
      Number( nowLocal.slice( 14, 16 ) );


    if (
      minutes <
        startHour *
        60 ||
      minutes >
        endHour *
        60
    ) {

      return;

    }


    const line =
      document.createElement( 'div' );

    line.className =
      'now-line';

    line.style.top =
      (
        (
          minutes -
          startHour *
          60
        ) /
        60
      ) *
      64 +
      'px';


    const dot =
      document.createElement( 'span' );

    dot.className =
      'now-dot';

    line.appendChild( dot );

    column.appendChild( line );

  }





  /* =========================================================
     WEEK SUMMARY (ADMIN)
     ========================================================= */

  /*
    How much of the week is spoken for, and by
    whom. Only blocked time counts as booked;
    availability is the offer, not the work.
    Everything is measured from what is drawn
    on the calendar, so a recurring series and
    a one-off are counted the same way and a
    session crossing midnight is split across
    the two days exactly as it appears.
  */

  function renderWeekSummary() {

    const panel =
      $('weekSummary');


    if ( !panel ) {

      return;

    }


    /*
      The summary speaks in weeks; in day and month views it would
      count a different span than the one on screen, so it sits out.
    */

    if ( state.view !== 'week' ) {

      panel.classList.add( 'hidden' );

      return;

    }


    panel
      .classList
      .toggle(
        'hidden',
        !state.isAdmin
      );


    if ( !state.isAdmin ) {

      return;

    }


    /*
      Every booked session of the week, once, with what the rows and
      the counts need: who, how long, when, which category, what
      color it is drawn in.
    */

    const sessions =
      [];


    for ( let day = 0; day < 7; day++ ) {

      const date =
        addDays(
          state.weekStart,
          day
        );


      const dateStr =
        formatDate( date );


      getSegmentsForDate( dateStr )
        .forEach(
          ({ event, startMin, endMin }) => {

            if (
              event.type !== 'BLOCKED'
            ) {

              return;

            }


            sessions.push({
              name:
                summaryStudentName( event ),
              minutes:
                Math.max( 0, endMin - startMin ),
              date,
              startMin,
              endMin,
              category:
                event.category === OMITTED ||
                categoryName( event.category )
                  ? event.category
                  : '',
              hex:
                normalizeHex( event.color ) ||
                defaultColorFor( 'BLOCKED' )
            });

          }
        );

    }


    /*
      Omitted sessions stay on the calendar but out of the count:
      not in the total, the students, or the rows under "All".
    */

    const counted =
      sessions.filter(
        (session) =>
          session.category !== OMITTED
      );


    const totalMinutes =
      counted.reduce(
        (sum, session) =>
          sum + session.minutes,
        0
      );


    const byCategory =
      new Map();


    sessions.forEach(
      (session) => {
        byCategory.set(
          session.category,
          ( byCategory.get( session.category ) || 0 ) + session.minutes
        );
      }
    );


    /*
      The chosen category filters the rows below; "All" is the
      default, and a category that no longer exists falls back to it.
    */

    if (
      state.summaryCategory !== 'all' &&
      state.summaryCategory !== 'none' &&
      state.summaryCategory !== OMITTED &&
      !categoryName( state.summaryCategory )
    ) {

      state.summaryCategory =
        'all';

    }


    const chosen =
      state.summaryCategory;


    const shown =
      chosen === 'all'
        ? counted
        : sessions.filter(
            (session) =>
              session.category === ( chosen === 'none' ? '' : chosen )
          );


    const byStudent =
      new Map();


    shown.forEach(
      (session) => {

        if ( !byStudent.has( session.name ) ) {

          byStudent.set(
            session.name,
            {
              name: session.name,
              minutes: 0,
              sessions: [],
              colors: new Map()
            }
          );

        }


        const record =
          byStudent.get( session.name );
        record.minutes += session.minutes;
        record.sessions.push( session );
        /*
          The color most of this student's time is drawn in
          marks their row; the default red counts as a color.
        */
        record.colors.set(
          session.hex,
          ( record.colors.get( session.hex ) || 0 ) + session.minutes
        );

      }
    );


    $('summaryHours')
      .textContent =
        formatHours( totalMinutes );


    $('summaryStudents')
      .textContent =
        String( new Set( counted.map( (session) => session.name ) ).size );


    renderSummaryCategories(
      byCategory,
      totalMinutes
    );


    const list =
      $('summaryList');


    list.innerHTML = '';


    if ( byStudent.size === 0 ) {

      const empty =
        document
          .createElement( 'li' );


      empty.className =
        'week-summary-empty';


      empty.textContent =
        chosen === 'all'
          ? t( 'nothing_blocked_week' )
          : t( 'nothing_in_category', { name: chosen === 'none' ? t( 'summary_uncategorized' ) : chosen === OMITTED ? t( 'summary_omitted' ) : categoryName( chosen ) } );


      list.appendChild( empty );


      return;

    }


    /*
      Busiest first: the person to look at is
      the one taking the most of the week.
    */

    [ ...byStudent.values() ]
      .sort(
        (a, b) =>
          b.minutes - a.minutes ||
          a.name.localeCompare( b.name )
      )
      .forEach(
        (record) => {

          const item =
            document
              .createElement( 'li' );


          item.className =
            'week-summary-student';


          const head =
            document
              .createElement( 'div' );


          head.className =
            'week-summary-student-head';


          const who =
            document
              .createElement( 'strong' );
          const dot =
            document
              .createElement( 'span' );
          dot.className =
            'week-summary-dot';
          const dominant =
            [ ...record.colors.entries() ]
              .sort(
                (a, b) =>
                  b[1] - a[1]
              )[0];
          const shades =
            cardShades( dominant[0] );
          dot.style.setProperty(
            '--dot',
            shades.ink
          );
          item.style.setProperty( '--row-edge', shades.border );
          item.style.setProperty( '--row-tint', shades.tint );
          item.style.setProperty( '--row-ink', shades.ink );
          dot.title =
            colorName( dominant[0] );
          who.append(
            dot,
            document.createTextNode( record.name )
          );


          const hours =
            document
              .createElement( 'span' );


          hours.className =
            'week-summary-student-hours';


          hours.textContent =
            formatHours( record.minutes ) +
            ' hr' +
            ( record.minutes === 60
              ? ''
              : 's' ) +
            ' · ' +
            record.sessions.length +
            ( record.sessions.length === 1
              ? ' session'
              : ' sessions' );


          head.appendChild( who );

          head.appendChild( hours );


          /*
            One session to a line: a week of them read as a column,
            not a run-on.
          */

          const when =
            document
              .createElement( 'div' );


          when.className =
            'week-summary-sessions';


          record.sessions
            .sort(
              (a, b) =>
                a.date - b.date ||
                a.startMin - b.startMin
            )
            .forEach(
              (session) => {
                const line =
                  document.createElement( 'div' );
                line.className =
                  'week-summary-session';
                line.textContent =
                  summarySessionLabel( session );
                when.appendChild( line );
              }
            );


          item.appendChild( head );

          item.appendChild( when );


          list.appendChild( item );

        }
      );

  }


  /*
    One count per category the owner named, in the order named, and
    "Uncategorized" for booked time filed under none - shown only
    once there is at least one category to count apart. "All" comes
    first and is the default; each count is a button that narrows
    the rows below to that category. "Omitted" comes last, apart
    from the total, whenever the week has any.
  */
  function renderSummaryCategories(
    byCategory,
    totalMinutes
  ) {
    const box =
      $('summaryCategories');
    box.innerHTML = '';
    if (
      !state.categories.length &&
      !byCategory.get( OMITTED )
    ) {
      box.classList.add( 'hidden' );
      return;
    }
    box.classList.remove( 'hidden' );
    const rows =
      [
        {
          key: 'all',
          name: t( 'summary_all' ),
          minutes: totalMinutes
        },
        ...state.categories.map(
          (category) => ({
            key: category.id,
            name: category.name,
            minutes: byCategory.get( category.id ) || 0
          })
        )
      ];
    if (
      state.categories.length &&
      byCategory.get( '' )
    ) {
      rows.push({
        key: 'none',
        name: t( 'summary_uncategorized' ),
        minutes: byCategory.get( '' )
      });
    }
    if ( byCategory.get( OMITTED ) ) {
      rows.push({
        key: OMITTED,
        name: t( 'summary_omitted' ),
        minutes: byCategory.get( OMITTED )
      });
    }
    rows.forEach(
      (row) => {
        const chip =
          document.createElement( 'button' );
        chip.type = 'button';
        chip.className =
          'week-summary-category' +
          ( row.key === 'none' ? ' none' : '' ) +
          ( row.key === OMITTED ? ' omitted' : '' );
        chip.dataset.category =
          row.key;
        chip.setAttribute(
          'aria-pressed',
          state.summaryCategory === row.key ? 'true' : 'false'
        );
        const number =
          document.createElement( 'strong' );
        number.textContent =
          formatHours( row.minutes );
        const label =
          document.createElement( 'span' );
        label.textContent =
          t( 'category_hours', { name: row.name } );
        chip.append( number, label );
        chip.addEventListener(
          'click',
          () => {
            state.summaryCategory =
              row.key;
            renderWeekSummary();
          }
        );
        box.appendChild( chip );
      }
    );
  }


  function summaryStudentName(
    event
  ) {

    const title =
      ( event.title || '' ).trim();


    if ( !title ) {

      return 'Unlabelled';

    }


    const cut =
      title.split(
        /\s+[-–—(|,]\s*|\s+\(/
      )[0];


    return (
      cut.trim() ||
      title
    );

  }


  function summarySessionLabel(
    session
  ) {

    const day =
      session.date
        .toLocaleDateString(
          I18N.locale(),
          {
            weekday: 'short'
          }
        );


    return (
      day +
      ' ' +
      formatClockLabel(
        Math.floor( session.startMin / 60 ),
        session.startMin % 60
      )
        .replace( ':00', '' )
        .toLowerCase()
        .replace( ' ', '' ) +
      '-' +
      formatClockLabel(
        Math.floor( session.endMin / 60 ),
        session.endMin % 60
      )
        .replace( ':00', '' )
        .toLowerCase()
        .replace( ' ', '' )
    );

  }


  /*
    Half hours read better than 1.5000000001,
    and a whole number should not carry a
    trailing .0.
  */

  function formatHours(
    minutes
  ) {

    const hours =
      Math.round(
        minutes / 60 * 100
      ) / 100;


    return (
      Number.isInteger( hours )
        ? String( hours )
        : hours
            .toFixed( 2 )
            .replace( /0$/, '' )
    );

  }


  function renderWeekLabel() {

    if ( state.view === 'day' ) {

      $('weekLabel')
        .textContent =
          state.weekStart.toLocaleDateString(
            I18N.locale(),
            {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric'
            }
          );

      return;

    }


    if ( state.view === 'month' ) {

      $('weekLabel')
        .textContent =
          state.weekStart.toLocaleDateString(
            I18N.locale(),
            {
              month: 'long',
              year: 'numeric'
            }
          );

      return;

    }


    const end =
      addDays(
        state.weekStart,
        6
      );


    $('weekLabel')
      .textContent =
        state.weekStart
          .toLocaleDateString(
            I18N.locale(),
            {
              month:
                'short',

              day:
                'numeric'
            }
          ) +
        ' – ' +
        end.toLocaleDateString(
          I18N.locale(),
          {
            month:
              'short',

            day:
              'numeric',

            year:
              'numeric'
          }
        );

  }



  /* =========================================================
     ADMIN DISPLAY CALCULATION
  ========================================================= */


  function getDisplayEvents() {

    if (
      !state.isAdmin
    ) {

      return state.events;

    }


    const availability =
      state.events
        .filter(
          (event) =>
            event.type ===
            'AVAILABLE'
        );


    const blocked =
      state.events
        .filter(
          (event) =>
            event.type ===
            'BLOCKED'
        );


    /*
      Blocked events are always
      displayed in admin mode.
    */

    const displayEvents =
      blocked.map(
        (event) => ({
          ...event
        })
      );


    /*
      Split availability around
      blocked sessions.
    */

    for (
      const available of
      availability
    ) {

      const availableStart =
        localDateTimeToMinuteKey(
          available.start
        );


      const availableEnd =
        localDateTimeToMinuteKey(
          available.end
        );


      let pieces = [
        [
          availableStart,
          availableEnd
        ]
      ];


      for (
        const block of
        blocked
      ) {

        const blockStart =
          localDateTimeToMinuteKey(
            block.start
          );


        const blockEnd =
          localDateTimeToMinuteKey(
            block.end
          );


        const nextPieces =
          [];


        for (
          const [
            start,
            end
          ] of pieces
        ) {

          /*
            No overlap.
          */

          if (
            blockEnd <=
              start ||
            blockStart >=
              end
          ) {

            nextPieces.push(
              [
                start,
                end
              ]
            );

            continue;

          }


          /*
            Portion before block.
          */

          if (
            blockStart >
            start
          ) {

            nextPieces.push([
              start,

              Math.min(
                blockStart,
                end
              )
            ]);

          }


          /*
            Portion after block.
          */

          if (
            blockEnd <
            end
          ) {

            nextPieces.push([
              Math.max(
                blockEnd,
                start
              ),

              end
            ]);

          }

        }


        pieces =
          nextPieces;


        if (
          !pieces.length
        ) {

          break;

        }

      }


      pieces.forEach(
        (
          [
            start,
            end
          ],
          index
        ) => {

          displayEvents.push({

            ...available,

            displayId:
              `${available.id}-fragment-${start}-${index}`,

            masterId:
              available.masterId ||
              available.id,

            start:
              minuteKeyToLocalDateTime(
                start
              ),

            end:
              minuteKeyToLocalDateTime(
                end
              )

          });

        }
      );

    }


    return displayEvents
      .sort(
        (a, b) =>
          localDateTimeToMinuteKey(
            a.start
          ) -
          localDateTimeToMinuteKey(
            b.start
          )
      );

  }



  /* =========================================================
     CALENDAR
  ========================================================= */


  function renderCalendar() {

    if ( state.view === 'month' ) {

      renderMonthGrid();

      return;

    }


    calendar.classList.remove( 'month-mode' );


    /*
      Day view is one wide column; the CSS week template only knows
      seven, so the day template is set inline and cleared again for
      week view, where the stylesheet - mobile compaction included -
      stays in charge.
    */

    const dayCount =
      state.view === 'day'
        ? 1
        : 7;


    calendar.style.gridTemplateColumns =
      state.view === 'day'
        ? '70px 1fr'
        : '';


    const startHour =
      Number(
        state.config
          .dayStart ??
        8
      );


    const endHour =
      Number(
        state.config
          .dayEnd ??
        24
      );


    const totalHeight =
      (
        endHour -
        startHour
      ) *
      64;


    const today =
      formatDate(
        new Date()
      );


    calendar.innerHTML =
      '';


    /*
      Top-left corner.
    */

    const corner =
      document.createElement(
        'div'
      );


    corner.className =
      'corner';


    calendar.appendChild(
      corner
    );


    /*
      Day headers.
    */

    for (
      let d = 0;
      d < dayCount;
      d++
    ) {

      const date =
        addDays(
          state.weekStart,
          d
        );


      const head =
        document.createElement(
          'div'
        );


      head.className =
        'day-head' +
        (
          formatDate(
            date
          ) ===
          today
            ? ' today'
            : ''
        );


      head.innerHTML =
        `<div class="dow">${
          date.toLocaleDateString(
            I18N.locale(),
            {
              weekday:
                'short'
            }
          )
        }</div>` +
        `<div class="date-num">${
          date.getDate()
        }</div>`;


      calendar.appendChild(
        head
      );

    }


    /*
      Time labels.
    */

    const timeColumn =
      document.createElement(
        'div'
      );


    timeColumn.className =
      'time-column';


    timeColumn.style.height =
      totalHeight +
      'px';


    for (
      let hour =
        startHour;
      hour <=
        endHour;
      hour++
    ) {

      const label =
        document.createElement(
          'div'
        );


      label.className =
        'time-label' +
        /*
          The first and last labels sit on the grid's edges, where a
          centred label would be half outside it - so they hang below
          the top line and above the bottom one instead.
        */
        (
          hour === startHour
            ? ' first'
            : hour === endHour
              ? ' last'
              : ''
        );

      label.style.top =
        (
          (
            hour -
            startHour
          ) *
          64
        ) +
        'px';


      label.textContent =
        formatMinutes(
          hour *
          60
        );


      timeColumn.appendChild(
        label
      );

    }


    calendar.appendChild(
      timeColumn
    );


    /*
      Day columns.
    */

    for (
      let d = 0;
      d < dayCount;
      d++
    ) {

      const date =
        addDays(
          state.weekStart,
          d
        );


      const dateStr =
        formatDate(
          date
        );


      const column =
        document.createElement(
          'div'
        );


      column.className =
        'day-column';


      column.dataset.date =
        dateStr;


      column.style.height =
        totalHeight +
        'px';


      if (
        state.isAdmin
      ) {

        column.addEventListener(
          'dragover',
          (event) => {

            event.preventDefault();

            column
              .classList
              .add(
                'drag-over'
              );


            /*
              The grey placeholder that clicks from slot to slot under
              the drag, showing exactly where the block will land -
              same snap, same clamp as the drop itself, because both
              read pointerMinuteOfDay.
            */

            positionDragGhost(
              column,
              event.clientY
            );

          }
        );


        column.addEventListener(
          'dragleave',
          () => {

            column
              .classList
              .remove(
                'drag-over'
              );

          }
        );


        column.addEventListener(
          'drop',
          (event) => {

            handleDrop(
              event,
              column
            );

          }
        );


        column.addEventListener(
          'click',
          (event) => {

            handleScheduleClick(
              event,
              column
            );

          }
        );


        column.addEventListener(
          'contextmenu',
          (event) => {

            handleScheduleContextMenu(
              event,
              column
            );

          }
        );

      }


      getSegmentsForDate(
        dateStr
      )
        .forEach(
          ({
            event,
            startMin,
            endMin
          }) => {

            const card =
              createEventCard(
                event,
                startMin,
                endMin,
                startHour,
                endHour
              );


            if (
              card
            ) {

              column.appendChild(
                card
              );

            }

          }
        );


      calendar.appendChild(
        column
      );

    }

  }



  function getSegmentsForDate(
    dateStr
  ) {

    const dayStart =
      localDateTimeToMinuteKey(
        dateStr +
        'T00:00'
      );


    const dayEnd =
      dayStart +
      1440;


    return getDisplayEvents()
      .map(
        (event) => {

          const eventStart =
            localDateTimeToMinuteKey(
              event.start
            );


          const eventEnd =
            localDateTimeToMinuteKey(
              event.end
            );


          const segmentStart =
            Math.max(
              eventStart,
              dayStart
            );


          const segmentEnd =
            Math.min(
              eventEnd,
              dayEnd
            );


          if (
            segmentStart >=
            segmentEnd
          ) {

            return null;

          }


          return {

            event,

            startMin:
              segmentStart -
              dayStart,

            endMin:
              segmentEnd -
              dayStart

          };

        }
      )
      .filter(
        Boolean
      )
      .sort(
        (a, b) =>
          a.startMin -
            b.startMin ||
          a.endMin -
            b.endMin
      );

  }



  function createEventCard(
    event,
    segmentStartMin,
    segmentEndMin,
    startHour,
    endHour
  ) {

    const visibleStart =
      startHour *
      60;


    const visibleEnd =
      endHour *
      60;


    if (
      segmentEndMin <=
        visibleStart ||
      segmentStartMin >=
        visibleEnd
    ) {

      return null;

    }


    const clippedStart =
      Math.max(
        segmentStartMin,
        visibleStart
      );


    const clippedEnd =
      Math.min(
        segmentEndMin,
        visibleEnd
      );


    const top =
      (
        (
          clippedStart -
          visibleStart
        ) /
        60
      ) *
      64;


    const height =
      Math.max(
        (
          (
            clippedEnd -
            clippedStart
          ) /
          60
        ) *
        64,
        18
      );


    const card =
      document.createElement(
        'div'
      );


    card.className =
      'event-card ' +
      (
        event.type ===
        'BLOCKED'
          ? 'blocked'
          : 'available'
      ) +
      (
        state.isAdmin
          ? ' admin'
          : ''
      ) +
      (
        height <
        40
          ? ' compact'
          : ''
      );


    card.style.top =
      top +
      'px';
    /*
      The length goes in as a custom property rather than a height,
      so the stylesheet can let a card grow under the pointer to show
      all of its text and still hold it to its own length.
    */
    card.style.setProperty(
      '--card-height',
      height +
      'px'
    );
    applyEventColor(
      card,
      event
    );
    /*
      Public users never see
      private blocked titles.
    */

    const title =
      state.isAdmin
        ? (
            event.title ||
            labelFor( event.type )
          )
        : labelFor( event.type );


    const titleElement =
      document.createElement(
        'div'
      );


    titleElement.className =
      'event-title';


    titleElement.textContent =
      title;


    const timeElement =
      document.createElement(
        'div'
      );


    timeElement.className =
      'event-time';


    timeElement.textContent =
      formatMinuteRange(
        segmentStartMin,
        segmentEndMin
      );


        card.append(
      titleElement,
      timeElement
    );
    if ( event.overlay ) {
      card.classList.add( 'overlay' );
      card.dataset.calendar =
        event.overlay;
      card.title =
        event.overlayTitle || event.overlay;
      const tag =
        document.createElement( 'div' );
      tag.className =
        'overlay-tag';
      tag.textContent =
        event.overlayTitle || event.overlay;
      card.appendChild( tag );
    }


    /*
      Admin interaction.
    */

    if (
      state.isAdmin
    ) {

      const original =
        getOriginalEvent(
          event
        );


      const recurring =
        Boolean(
          original
            ?.recurrence
        );


      /*
        Everything drags. A one-time event moves outright; a repeating
        one is asked, on drop, how much of the series moves with it -
        so the card remembers which occurrence was picked up, because
        "just this block" means the block in the admin's hand.
      */

      card.draggable =
        true;


      card.addEventListener(
        'dragstart',
        (dragEvent) => {

          state.draggingId =
            original.masterId ||
            original.id;


          state.draggingOccurrence =
            recurring
              ? wholeOccurrence( event )
              : null;


          state.draggingDuration =
            localDateTimeToMinuteKey(
              wholeOccurrence( event ).end
            ) -
            localDateTimeToMinuteKey(
              wholeOccurrence( event ).start
            );


          /*
            The dragged card's own time line becomes the live readout
            of the landing slot - the ghost sits under the browser's
            drag image and any text on it would be covered.
          */

          state.draggingTimeEl =
            card.querySelector( '.event-time' );


          state.draggingTimeText =
            state.draggingTimeEl
              ? state.draggingTimeEl.textContent
              : '';


          /*
            Where on the block the hand grabbed it, in minutes from
            its visible top. Subtracted before snapping, so a block
            grabbed by its middle lands where the BLOCK sits, not
            half a block below the pointer.
          */

          state.draggingGrabOffset =
            (
              (
                dragEvent.clientY -
                card.getBoundingClientRect().top
              ) /
              64
            ) *
            60;


          dragEvent
            .dataTransfer
            .effectAllowed =
              'move';


          dragEvent
            .dataTransfer
            .setData(
              'text/plain',
              state.draggingId
            );

        }
      );


      card.addEventListener(
        'dragend',
        () => {

          removeDragGhost();


          state.draggingId =
            null;


          state.draggingOccurrence =
            null;


          state.draggingGrabOffset =
            0;


          if ( state.draggingTimeEl ) {

            state.draggingTimeEl.textContent =
              state.draggingTimeText;


            state.draggingTimeEl =
              null;

          }


          state.suppressNextScheduleClick =
            true;


          document
            .querySelectorAll(
              '.drag-over'
            )
            .forEach(
              (element) => {

                element
                  .classList
                  .remove(
                    'drag-over'
                  );

              }
            );

        }
      );


      /*
        Left-clicking a booked session opens it
        for editing - the block already is the
        thing you mean. Availability and empty
        space keep bubbling to the column, where
        a click adds a new session in that slot.
      */

      if (
        event.type ===
        'BLOCKED'
      ) {

        card.addEventListener(
          'click',
          (clickEvent) => {

            clickEvent
              .stopPropagation();


            /*
              A drop also ends in a click on the
              card. Swallow that one, the same
              way the column does.
            */

            if ( state.suppressNextScheduleClick ) {

              state.suppressNextScheduleClick =
                false;

              return;

            }


            if ( state.openContextMenu ) {

              closeContextMenu();

              return;

            }


            openEventModal(
              original,
              recurring
                ? wholeOccurrence( event )
                : original
            );

          }
        );

      }


      card.addEventListener(
        'contextmenu',
        (menuEvent) => {

          handleCardContextMenu(
            menuEvent,
            original,
            wholeOccurrence( event )
          );

        }
      );

    }


    return card;

  }



  /*
    A fragment of open time - the part of one block left on either
    side of a booked session - is a drawing, not a record. Whatever
    edits, moves, copies or deletes it must act on the whole block
    (the whole occurrence, for a series) it was cut from, or the
    pieces on the other side of the booking would be lost.
  */
  function wholeOccurrence(
    event
  ) {
    if ( !event || !event.displayId ) {
      return event;
    }
    const id =
      event.masterId ||
      event.id;
    const start =
      localDateTimeToMinuteKey( event.start );
    const end =
      localDateTimeToMinuteKey( event.end );
    return state.events.find(
      (item) =>
        ( item.masterId || item.id ) === id &&
        localDateTimeToMinuteKey( item.start ) <= start &&
        localDateTimeToMinuteKey( item.end ) >= end
    ) || getOriginalEvent( event );
  }


  function getOriginalEvent(
    event
  ) {

    const id =
      event.masterId ||
      event.id;


    const match =
      state.events.find(
        (item) =>
          (
            item.masterId ||
            item.id
          ) ===
          id
      );


    return match ||
      event;

  }



  /* =========================================================
     MOBILE AGENDA
  ========================================================= */


  function renderAgenda() {

    agenda.innerHTML =
      '';


    /*
      The agenda list is the week view's phone companion; day and
      month draw their own shapes.
    */

    if ( state.view !== 'week' ) {

      return;

    }


    for (
      let d = 0;
      d < 7;
      d++
    ) {

      const date =
        addDays(
          state.weekStart,
          d
        );


      const dateStr =
        formatDate(
          date
        );


      const segments =
        getSegmentsForDate(
          dateStr
        );


      const section =
        document.createElement(
          'section'
        );


      section.className =
        'agenda-day';


      const heading =
        document.createElement(
          'h3'
        );


      heading.textContent =
        date.toLocaleDateString(
          I18N.locale(),
          {
            weekday:
              'long',

            month:
              'short',

            day:
              'numeric'
          }
        );


      section.appendChild(
        heading
      );


      if (
        !segments.length
      ) {

        const empty =
          document.createElement(
            'div'
          );


        empty.className =
          'agenda-empty';


        empty.textContent =
          state.isAdmin
            ? t( 'no_events' )
            : t( 'no_availability' );


        section.appendChild(
          empty
        );

      } else {

        segments.forEach(
          ({
            event,
            startMin,
            endMin
          }) => {

            const item =
              document.createElement(
                state.isAdmin
                  ? 'button'
                  : 'div'
              );


            item.className =
              'agenda-item ' +
              (
                event.type ===
                'BLOCKED'
                  ? 'blocked'
                  : 'available'
              );
            applyEventColor(
              item,
              event
            );


            const left =
              document.createElement(
                'span'
              );


            const title =
              document.createElement(
                'strong'
              );


            const meta =
              document.createElement(
                'div'
              );


            const right =
              document.createElement(
                'span'
              );


            title.textContent =
              state.isAdmin
                ? (
                    event.title ||
                    labelFor( event.type )
                  )
                : labelFor( event.type );


            meta.className =
              'meta';


            meta.textContent =
              formatMinutes(
                startMin
              ) +
              ' – ' +
              formatMinutes(
                endMin
              );


            right.className =
              'meta';


            right.textContent =
              labelFor( event.type );


            left.append(
              title,
              meta
            );


            item.append(
              left,
              right
            );


            if (
              state.isAdmin
            ) {

              item.addEventListener(
                'click',
                () => {

                  openEventModal(
                    getOriginalEvent(
                      event
                    ),
                    event.masterId
                      ? wholeOccurrence( event )
                      : undefined
                  );

                }
              );

            }


            section.appendChild(
              item
            );

          }
        );

      }


      agenda.appendChild(
        section
      );

    }

  }



  /* =========================================================
     BLOCKED SESSION DRAWER
  ========================================================= */


  /*
    How far ahead the upcoming list looks,
    as the midnight that closes the window.

    It always ends on a Saturday, so the list
    is whole weeks rather than a rolling
    fortnight. Sunday stops at the end of
    this week, because a week of notice is
    already there; every other day takes next
    week as well, since a Friday would
    otherwise show almost nothing.
  */

  function upcomingWindowEnd(
    nowKey
  ) {

    const now =
      new Date(
        nowKey *
        60000
      );


    const startOfToday =
      nowKey -
      (
        now.getUTCHours() *
        60 +
        now.getUTCMinutes()
      );


    const weekday =
      now.getUTCDay();


    const daysToSaturday =
      6 -
      weekday;


    const nextWeek =
      weekday ===
      0
        ? 0
        : 7;


    return startOfToday +
      (
        daysToSaturday +
        nextWeek +
        1
      ) *
      1440;

  }



  async function openBlockedSessions() {

    if (
      !state.isAdmin
    ) {

      return;

    }


    $('blockedDrawerBackdrop')
      .classList
      .remove(
        'hidden'
      );


    $('blockedListStatus')
      .textContent =
        t( 'loading_blocked' );


    $('pastBlockedList')
      .innerHTML =
        '';


    $('upcomingBlockedList')
      .innerHTML =
        '';


    try {

      const nowKey =
        getPortalNowMinuteKey();


      /*
        One year backward and
        one year forward.
      */

      const startDate =
        minuteKeyToLocalDateTime(
          nowKey -
          365 *
          1440
        )
          .slice(
            0,
            10
          );


      const windowEnd =
        upcomingWindowEnd(
          nowKey
        );


      const endDate =
        minuteKeyToLocalDateTime(
          windowEnd -
          1
        )
          .slice(
            0,
            10
          );


      /*
        Say where the list stops, so a quiet
        column reads as nothing booked rather
        than as something failing to load.
      */

      $('upcomingBlockedRange')
        .textContent =
          t( 'through', { date: new Date(
            (
              windowEnd -
              1440
            ) *
            60000
          )
            .toLocaleDateString(
              I18N.locale(),
              {
                timeZone:
                  'UTC',

                weekday:
                  'short',

                month:
                  'short',

                day:
                  'numeric'
              }
            ) } );


      const data =
        await api(
          `/events?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
        );


      if (
        data.mode !==
        'admin'
      ) {

        throw new Error(
          t( 'admin_expired' )
        );

      }


      const blocked =
        (
          data.events ||
          []
        )
          .filter(
            (event) =>
              event.type ===
              'BLOCKED'
          );


      /*
        Past:
        event has ended.

        Current event:
        stays under Upcoming.
      */

      const past =
        blocked
          .filter(
            (event) =>
              localDateTimeToMinuteKey(
                event.end
              ) <=
              nowKey
          )
          .sort(
            (a, b) =>
              localDateTimeToMinuteKey(
                b.end
              ) -
              localDateTimeToMinuteKey(
                a.end
              )
          );


      const upcoming =
        blocked
          .filter(
            (event) =>
              localDateTimeToMinuteKey(
                event.end
              ) >
                nowKey &&
              localDateTimeToMinuteKey(
                event.start
              ) <
                windowEnd
          )
          .sort(
            (a, b) =>
              localDateTimeToMinuteKey(
                a.start
              ) -
              localDateTimeToMinuteKey(
                b.start
              )
          );


      $('pastBlockedCount')
        .textContent =
          past.length;


      $('upcomingBlockedCount')
        .textContent =
          upcoming.length;


      renderBlockedSessionList(
        $('pastBlockedList'),
        past,
        nowKey
      );


      renderBlockedSessionList(
        $('upcomingBlockedList'),
        upcoming,
        nowKey
      );


      $('blockedListStatus')
        .textContent =
          '';

    } catch (error) {

      $('blockedListStatus')
        .textContent =
          error.message;

    }

  }



  function closeBlockedSessions() {

    $('blockedDrawerBackdrop')
      .classList
      .add(
        'hidden'
      );

  }



  function renderBlockedSessionList(
    container,
    events,
    nowKey
  ) {

    container.innerHTML =
      '';


    if (
      !events.length
    ) {

      const empty =
        document.createElement(
          'div'
        );


      empty.className =
        'blocked-list-empty';


      empty.textContent =
        t( 'no_blocked' );


      container.appendChild(
        empty
      );


      return;

    }


    for (
      const event of
      events
    ) {

      const startKey =
        localDateTimeToMinuteKey(
          event.start
        );


      const endKey =
        localDateTimeToMinuteKey(
          event.end
        );


      const current =
        startKey <=
          nowKey &&
        endKey >
          nowKey;


      const button =
        document.createElement(
          'button'
        );


      button.type =
        'button';


      button.className =
        'blocked-session-item' +
        (
          current
            ? ' current'
            : ''
        );


      const title =
        document.createElement(
          'div'
        );


      title.className =
        'blocked-session-title';


      title.textContent =
        event.title ||
        labelFor( 'BLOCKED' );


      const time =
        document.createElement(
          'div'
        );


      time.className =
        'blocked-session-time';


      time.textContent =
        formatBlockedEventRange(
          event.start,
          event.end
        );


      const meta =
        document.createElement(
          'div'
        );


      meta.className =
        'blocked-session-meta';


      if (
        current
      ) {

        const currentBadge =
          document.createElement(
            'span'
          );


        currentBadge.textContent =
          t( 'happening_now' );


        meta.appendChild(
          currentBadge
        );

      }


      if (
        event.recurrence
      ) {

        const recurringBadge =
          document.createElement(
            'span'
          );


        recurringBadge.className =
          'recurring-badge';


        recurringBadge.textContent =
          t( 'recurring' );


        meta.appendChild(
          recurringBadge
        );

      }


      button.append(
        title,
        time,
        meta
      );


      button.addEventListener(
        'click',
        () => {

          closeBlockedSessions();


          /*
            A block of a series opens on ITS week, so "this event
            only" in the editor means the block that was tapped.
          */

          openEventModal(
            event,
            event.masterId
              ? event
              : undefined
          );

        }
      );


      container.appendChild(
        button
      );

    }

  }



  /* =========================================================
     DRAGGING
  ========================================================= */


  /*
    Where a pointer landed in a day column,
    as a minute of the day.

    Snapped to the nearest quarter hour: a
    drop lands wherever the cursor happens to
    be, which produced starts like 12:53, and
    the grid line the cursor was aiming at is
    what was actually meant.
  */

  function pointerMinuteOfDay(
    column,
    clientY
  ) {

    const rect =
      column
        .getBoundingClientRect();


    const y =
      Math.max(
        0,
        Math.min(
          rect.height,
          clientY -
          rect.top
        )
      );


    const startHour =
      Number(
        state.config
          .dayStart ??
        8
      );


    const endHour =
      Number(
        state.config
          .dayEnd ??
        24
      );


    /*
      The pointer is wherever the hand grabbed the block, which is
      rarely its top edge - so the grab offset recorded at dragstart
      comes off before snapping. Without it, a block picked up by the
      middle lands half a block below where it visibly sits.
    */

    const snapped =
      Math.round(
        (
          startHour *
          60 +
          (
            y /
            64
          ) *
          60 -
          (
            state.draggingGrabOffset ||
            0
          )
        ) /
        15
      ) *
      15;


    /*
      Keep the start inside the day on screen. Without the clamps, a
      drop on the last row rounds up past midnight and lands on
      tomorrow, and a tall block grabbed low pushes above the first
      row.
    */

    return Math.max(
      startHour *
      60,
      Math.min(
        snapped,
        endHour *
        60 -
        15
      )
    );

  }


  /*
    One ghost for the whole grid, adopted by whichever column the drag
    is over. It carries the dragged block's own duration and a time
    range label, so the admin reads the exact quarter-hour landing
    before letting go.
  */

  function positionDragGhost(
    column,
    clientY
  ) {

    const duration =
      state.draggingDuration ||
      60;


    const startHour =
      Number(
        state.config
          .dayStart ??
        8
      );


    const endHour =
      Number(
        state.config
          .dayEnd ??
        24
      );


    const startMin =
      pointerMinuteOfDay(
        column,
        clientY
      );


    const endMin =
      startMin +
      duration;


    const visibleStart =
      startHour *
      60;


    const visibleEnd =
      endHour *
      60;


    const top =
      (
        (
          Math.max(
            startMin,
            visibleStart
          ) -
          visibleStart
        ) /
        60
      ) *
      64;


    const height =
      Math.max(
        (
          (
            Math.min(
              endMin,
              visibleEnd
            ) -
            Math.max(
              startMin,
              visibleStart
            )
          ) /
          60
        ) *
        64,
        14
      );


    let ghost =
      state.dragGhost;


    if ( !ghost ) {

      ghost =
        document.createElement( 'div' );

      ghost.className =
        'drag-ghost';


      state.dragGhost =
        ghost;

    }


    if (
      ghost.parentElement !==
      column
    ) {

      column.appendChild( ghost );

    }


    ghost.style.top =
      top +
      'px';


    ghost.style.height =
      height +
      'px';


    /*
      The card in the hand announces the landing time; the ghost only
      marks the spot.
    */

    if ( state.draggingTimeEl ) {

      state.draggingTimeEl.textContent =
        formatMinuteRange(
          startMin,
          endMin
        );

    }

  }


  function removeDragGhost() {

    if ( state.dragGhost ) {

      state.dragGhost.remove();


      state.dragGhost =
        null;

    }

  }


  /* =========================================================
     MONTH VIEW
  ========================================================= */

  /*
    A month is for shape, not surgery: each day is a cell of compact
    chips, capped with a "+N more", and clicking a day opens it in the
    day view, where every verb - create, edit, drag, delete - already
    lives. Chips, times and visibility all come from
    getSegmentsForDate, the same source the grid draws from.
  */

  function renderMonthGrid() {

    calendar.classList.add( 'month-mode' );

    calendar.style.gridTemplateColumns =
      '';

    calendar.innerHTML =
      '';


    const range =
      visibleRange();


    const monthIndex =
      state.weekStart.getMonth();


    const todayStr =
      formatDate(
        new Date()
      );


    for (
      let d = 0;
      d < 7;
      d++
    ) {

      const head =
        document.createElement( 'div' );

      head.className =
        'month-dow';

      head.textContent =
        addDays(
          range.start,
          d
        ).toLocaleDateString(
          I18N.locale(),
          {
            weekday: 'short'
          }
        );

      calendar.appendChild( head );

    }


    for (
      let d = 0;
      d < 42;
      d++
    ) {

      const date =
        addDays(
          range.start,
          d
        );

      const dateStr =
        formatDate( date );


      const cell =
        document.createElement( 'div' );

      cell.className =
        'month-cell' +
        (
          date.getMonth() !==
          monthIndex
            ? ' other-month'
            : ''
        ) +
        (
          dateStr ===
          todayStr
            ? ' today'
            : ''
        );


      const num =
        document.createElement( 'div' );

      num.className =
        'month-num';

      num.textContent =
        date.getDate();

      cell.appendChild( num );


      const segments =
        getSegmentsForDate( dateStr )
          .slice()
          .sort(
            (a, b) =>
              a.startMin -
              b.startMin
          );


      const MAX_CHIPS = 4;


      segments
        .slice( 0, MAX_CHIPS )
        .forEach(
          ({ event, startMin, endMin }) => {

            const chip =
              document.createElement( 'div' );

            chip.className =
              'month-chip ' +
              (
                event.type ===
                'BLOCKED'
                  ? 'blocked'
                  : 'available'
              );

            chip.textContent =
              formatMinutes( startMin ) +
              ' ' +
              (
                event.title ||
                labelFor( event.type )
              );

            chip.title =
              formatMinuteRange(
                startMin,
                endMin
              );

            cell.appendChild( chip );

          }
        );


      if (
        segments.length >
        MAX_CHIPS
      ) {

        const more =
          document.createElement( 'div' );

        more.className =
          'month-more';

        more.textContent =
          '+' +
          (
            segments.length -
            MAX_CHIPS
          ) +
          ' more';

        cell.appendChild( more );

      }


      cell.addEventListener(
        'click',
        () => {

          switchToDay( dateStr );

        }
      );


      calendar.appendChild( cell );

    }

  }


  /* =========================================================
     SAVE THE WEEK AS AN IMAGE
  ========================================================= */

  /*
    Draw the whole week onto an offscreen canvas and hand it over as a
    PNG. The point is phones: the grid is wider than any phone screen,
    so a screenshot can never hold the week - this renders it at full
    size straight from the data, whatever the zoom. Whoever clicks
    gets exactly the view they are entitled to, because the cards come
    from getSegmentsForDate, the same source the grid draws from.
  */

  function roundRectPath(
    ctx,
    x,
    y,
    w,
    h,
    r
  ) {

    ctx.beginPath();
    ctx.moveTo( x + r, y );
    ctx.arcTo( x + w, y, x + w, y + h, r );
    ctx.arcTo( x + w, y + h, x, y + h, r );
    ctx.arcTo( x, y + h, x, y, r );
    ctx.arcTo( x, y, x + w, y, r );
    ctx.closePath();

  }


  function clipCanvasText(
    ctx,
    text,
    maxWidth
  ) {

    let out =
      String( text || '' );


    if ( ctx.measureText( out ).width <= maxWidth ) {

      return out;

    }


    while (
      out.length > 1 &&
      ctx.measureText( out + '…' ).width > maxWidth
    ) {

      out =
        out.slice( 0, -1 );

    }


    return out + '…';

  }


  function downloadWeekImage() {

    if ( state.view === 'month' ) {

      downloadMonthImage();

      return;

    }


    const range =
      visibleRange();


    const dayCount =
      state.view === 'day'
        ? 1
        : 7;


    const startHour =
      Number(
        state.config.dayStart ??
        8
      );


    const endHour =
      Number(
        state.config.dayEnd ??
        24
      );


    const HOUR_H = 48;
    const GUTTER = 64;
    const COL_W =
      state.view === 'day'
        ? 420
        : 168;
    const HEAD_H = 96;
    const PAD = 16;


    const gridH =
      ( endHour - startHour ) *
      HOUR_H;


    const width =
      PAD * 2 +
      GUTTER +
      COL_W * dayCount;


    const height =
      HEAD_H +
      gridH +
      PAD * 2;


    const scale = 2;

    const canvas =
      document.createElement( 'canvas' );

    canvas.width =
      width * scale;

    canvas.height =
      height * scale;


    const ctx =
      canvas.getContext( '2d' );

    ctx.scale( scale, scale );


    const font =
      (px, weight) =>
        ( weight ? weight + ' ' : '' ) +
        px +
        'px Inter, system-ui, sans-serif';


    ctx.fillStyle = '#f6f7fb';
    ctx.fillRect( 0, 0, width, height );


    ctx.fillStyle = '#172033';
    ctx.font = font( 17, '700' );
    ctx.fillText(
      state.config.portalTitle || 'Schedule',
      PAD,
      PAD + 18
    );

    ctx.font = font( 13, '600' );
    ctx.fillStyle = '#687188';
    ctx.fillText(
      $('weekLabel').textContent +
      ( state.config.timezoneLabel
        ? '   ·   ' + state.config.timezoneLabel
        : '' ),
      PAD,
      PAD + 40
    );


    const gridTop = HEAD_H;
    const gridLeft = PAD + GUTTER;


    ctx.fillStyle = '#ffffff';
    ctx.fillRect(
      PAD,
      gridTop - 34,
      GUTTER + COL_W * dayCount,
      34 + gridH
    );

    ctx.strokeStyle = '#dde2ec';
    ctx.strokeRect(
      PAD + 0.5,
      gridTop - 33.5,
      GUTTER + COL_W * dayCount - 1,
      33 + gridH
    );


    ctx.font = font( 10 );

    for (
      let h = startHour;
      h <= endHour;
      h++
    ) {

      const y =
        gridTop +
        ( h - startHour ) *
        HOUR_H;

      ctx.strokeStyle = '#eef1f6';
      ctx.beginPath();
      ctx.moveTo( gridLeft, y + 0.5 );
      ctx.lineTo( gridLeft + COL_W * dayCount, y + 0.5 );
      ctx.stroke();

      ctx.fillStyle = '#687188';
      ctx.textAlign = 'right';
      ctx.fillText(
        formatMinutes( h * 60 ),
        gridLeft - 8,
        y + 3
      );
      ctx.textAlign = 'left';

    }


    const todayStr =
      minuteKeyToLocalDateTime(
        getPortalNowMinuteKey()
      ).slice( 0, 10 );


    for (
      let d = 0;
      d < dayCount;
      d++
    ) {

      const date =
        addDays(
          range.start,
          d
        );

      const dateStr =
        formatDate( date );

      const x =
        gridLeft +
        d * COL_W;


      ctx.strokeStyle = '#dde2ec';
      ctx.beginPath();
      ctx.moveTo( x + 0.5, gridTop - 34 );
      ctx.lineTo( x + 0.5, gridTop + gridH );
      ctx.stroke();


      const isToday =
        dateStr ===
        todayStr;

      ctx.fillStyle =
        isToday
          ? '#315efb'
          : '#172033';

      ctx.font = font( 12, '700' );
      ctx.fillText(
        date.toLocaleDateString(
          I18N.locale(),
          {
            weekday: 'short',
            month: 'numeric',
            day: 'numeric'
          }
        ),
        x + 8,
        gridTop - 12
      );


      getSegmentsForDate( dateStr ).forEach(
        ({ event, startMin, endMin }) => {

          const from =
            Math.max(
              startMin,
              startHour * 60
            );

          const to =
            Math.min(
              endMin,
              endHour * 60
            );

          if ( to <= from ) {

            return;

          }


          const top =
            gridTop +
            (
              ( from - startHour * 60 ) /
              60
            ) *
            HOUR_H;

          const cardH =
            Math.max(
              ( ( to - from ) / 60 ) *
              HOUR_H,
              12
            );

          const blocked =
            event.type ===
            'BLOCKED';
          const shades =
            exportShades( event );
          ctx.fillStyle =
            shades.tint;
          ctx.strokeStyle =
            shades.border;

          roundRectPath(
            ctx,
            x + 3,
            top + 1,
            COL_W - 6,
            cardH - 2,
            5
          );

          ctx.fill();
          ctx.stroke();


          /*
            Text stays inside the card, as on the page: two lines when
            there is room, otherwise one line with the title cut to
            leave the time whole - "Tutorin… 7:45 – 8 PM".
          */
          ctx.save();
          roundRectPath(
            ctx,
            x + 3,
            top + 1,
            COL_W - 6,
            cardH - 2,
            5
          );
          ctx.clip();
          ctx.fillStyle =
            shades.ink;
          const title =
            event.title ||
            labelFor( blocked ? 'BLOCKED' : 'AVAILABLE' );
          const range =
            formatMinuteRange( from, to );
          if ( cardH >= 28 ) {
            ctx.font = font( 11, '700' );
            ctx.fillText(
              clipCanvasText( ctx, title, COL_W - 16 ),
              x + 9,
              top + 14
            );
            ctx.font = font( 10 );
            ctx.fillText(
              clipCanvasText( ctx, range, COL_W - 16 ),
              x + 9,
              top + 27
            );
          } else {
            const size =
              cardH >= 18 ? 10 : 9;
            const baseline =
              top + cardH / 2 + size * 0.36;
            ctx.font = font( size );
            const rangeWidth =
              ctx.measureText( range ).width;
            ctx.font = font( size, '700' );
            const gap = 8;
            const titleText =
              clipCanvasText( ctx, title, Math.max( 0, COL_W - 16 - rangeWidth - gap ) );
            ctx.fillText( titleText, x + 9, baseline );
            const titleWidth =
              ctx.measureText( titleText ).width;
            ctx.font = font( size );
            ctx.fillText(
              range,
              x + 9 + titleWidth + ( titleText ? gap : 0 ),
              baseline
            );
          }
          ctx.restore();

        }
      );


      if ( isToday ) {

        const nowLocal =
          minuteKeyToLocalDateTime(
            getPortalNowMinuteKey()
          );

        const minutes =
          Number( nowLocal.slice( 11, 13 ) ) *
          60 +
          Number( nowLocal.slice( 14, 16 ) );

        if (
          minutes >= startHour * 60 &&
          minutes <= endHour * 60
        ) {

          const y =
            gridTop +
            (
              ( minutes - startHour * 60 ) /
              60
            ) *
            HOUR_H;

          ctx.strokeStyle = '#e14b4b';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo( x, y );
          ctx.lineTo( x + COL_W, y );
          ctx.stroke();
          ctx.lineWidth = 1;

        }

      }

    }


    saveCanvasPng( canvas );

  }


  function saveCanvasPng(
    canvas
  ) {

    canvas.toBlob(
      (blob) => {

        if ( !blob ) {

          setStatus(
            t( 'image_failed' )
          );

          return;

        }


        const url =
          URL.createObjectURL( blob );

        const link =
          document.createElement( 'a' );

        link.href =
          url;

                link.download =
          downloadName() +
          '.png';

        document.body.appendChild( link );
        link.click();
        link.remove();

        setTimeout(
          () => {

            URL.revokeObjectURL( url );

          },
          4000
        );


        setStatus(
          t( 'image_saved', { view: t( 'view_' + VIEW_WORD[ state.view ] ) } )
        );

      },
      'image/png'
    );

  }


  /*
    The month image mirrors the month view: a title, a weekday header
    row, and 42 cells of compact chips - the shape of the month at a
    glance, sized for sharing rather than surgery.
  */

  function downloadMonthImage() {

    const range =
      visibleRange();


    const COL_W = 172;
    const CELL_H = 112;
    const DOW_H = 26;
    const HEAD_H = 64;
    const PAD = 16;


    const width =
      PAD * 2 +
      COL_W * 7;


    const height =
      HEAD_H +
      DOW_H +
      CELL_H * 6 +
      PAD * 2;


    const scale = 2;

    const canvas =
      document.createElement( 'canvas' );

    canvas.width =
      width * scale;

    canvas.height =
      height * scale;


    const ctx =
      canvas.getContext( '2d' );

    ctx.scale( scale, scale );


    const font =
      (px, weight) =>
        ( weight ? weight + ' ' : '' ) +
        px +
        'px Inter, system-ui, sans-serif';


    ctx.fillStyle = '#f6f7fb';
    ctx.fillRect( 0, 0, width, height );

    ctx.fillStyle = '#172033';
    ctx.font = font( 17, '700' );
    ctx.fillText(
      state.config.portalTitle || 'Schedule',
      PAD,
      PAD + 18
    );

    ctx.font = font( 13, '600' );
    ctx.fillStyle = '#687188';
    ctx.fillText(
      $('weekLabel').textContent,
      PAD,
      PAD + 40
    );


    const top = HEAD_H;
    const left = PAD;


    const monthIndex =
      state.weekStart.getMonth();


    const todayStr =
      formatDate(
        new Date()
      );


    for (
      let d = 0;
      d < 7;
      d++
    ) {

      ctx.fillStyle = '#ffffff';
      ctx.fillRect( left + d * COL_W, top, COL_W, DOW_H );
      ctx.strokeStyle = '#dde2ec';
      ctx.strokeRect( left + d * COL_W + 0.5, top + 0.5, COL_W - 1, DOW_H - 1 );

      ctx.fillStyle = '#687188';
      ctx.font = font( 10, '700' );
      ctx.fillText(
        addDays( range.start, d )
          .toLocaleDateString( I18N.locale(), { weekday: 'short' } )
          .toUpperCase(),
        left + d * COL_W + 8,
        top + 17
      );

    }


    for (
      let d = 0;
      d < 42;
      d++
    ) {

      const date =
        addDays(
          range.start,
          d
        );

      const dateStr =
        formatDate( date );

      const x =
        left +
        ( d % 7 ) *
        COL_W;

      const y =
        top +
        DOW_H +
        Math.floor( d / 7 ) *
        CELL_H;


      const inMonth =
        date.getMonth() ===
        monthIndex;


      ctx.fillStyle =
        inMonth
          ? '#ffffff'
          : '#fafbfd';

      ctx.fillRect( x, y, COL_W, CELL_H );
      ctx.strokeStyle = '#dde2ec';
      ctx.strokeRect( x + 0.5, y + 0.5, COL_W - 1, CELL_H - 1 );


      const isToday =
        dateStr ===
        todayStr;

      if ( isToday ) {

        ctx.fillStyle = '#315efb';
        ctx.beginPath();
        ctx.arc( x + 15, y + 14, 10, 0, Math.PI * 2 );
        ctx.fill();

      }

      ctx.fillStyle =
        isToday
          ? '#ffffff'
          : inMonth
            ? '#172033'
            : '#687188';

      ctx.font = font( 11, '700' );
      ctx.fillText(
        String( date.getDate() ),
        x + ( date.getDate() > 9 ? 9 : 12 ),
        y + 18
      );


      const segments =
        getSegmentsForDate( dateStr )
          .slice()
          .sort(
            (a, b) =>
              a.startMin -
              b.startMin
          );


      const MAX_CHIPS = 4;


      segments
        .slice( 0, MAX_CHIPS )
        .forEach(
          ({ event, startMin }, index) => {

            const blocked =
              event.type ===
              'BLOCKED';

            const chipY =
              y +
              26 +
              index * 19;

            const shades =
              exportShades( event );
            ctx.fillStyle =
              shades.tint;
            roundRectPath(
              ctx,
              x + 4,
              chipY,
              COL_W - 8,
              16,
              4
            );

            ctx.fill();

            ctx.fillStyle =
              shades.ink;
            ctx.font = font( 9.5, '600' );
            ctx.fillText(
              clipCanvasText(
                ctx,
                formatMinutes( startMin ) +
                ' ' +
                (
                  event.title ||
                  labelFor( blocked ? 'BLOCKED' : 'AVAILABLE' )
                ),
                COL_W - 16
              ),
              x + 8,
              chipY + 12
            );

          }
        );


      if (
        segments.length >
        MAX_CHIPS
      ) {

        ctx.fillStyle = '#687188';
        ctx.font = font( 9 );
        ctx.fillText(
          '+' +
          (
            segments.length -
            MAX_CHIPS
          ) +
          ' more',
          x + 8,
          y +
          CELL_H -
          6
        );

      }

    }


    saveCanvasPng( canvas );

  }



  async function handleDrop(
    event,
    column
  ) {

    beginAction( 'move session' );


    event.preventDefault();


    removeDragGhost();


    column
      .classList
      .remove(
        'drag-over'
      );


    const id =
      event
        .dataTransfer
        .getData(
          'text/plain'
        ) ||
      state.draggingId;


    const storedEvent =
      state.events.find(
        (item) =>
          (
            item.masterId ||
            item.id
          ) ===
          id
      );


    if (
      !storedEvent
    ) {

      return;

    }


    if (
      storedEvent.recurrence
    ) {

      /*
        A repeating block is not moved blindly: the drop asks how much
        of the series comes along. The exact card picked up was
        remembered at dragstart; the stored event found by id is only
        the week's first occurrence, which may be a different day.
      */

      await moveRecurringDrop(
        storedEvent,
        state.draggingOccurrence ||
        storedEvent,
        column,
        event
      );


      return;

    }


    const newStartMinuteOfDay =
      pointerMinuteOfDay(
        column,
        event.clientY
      );


    const oldStartKey =
      localDateTimeToMinuteKey(
        storedEvent.start
      );


    const oldEndKey =
      localDateTimeToMinuteKey(
        storedEvent.end
      );


    const duration =
      oldEndKey -
      oldStartKey;


    const newStart =
      dateAndMinutesToLocalDateTime(
        column.dataset.date,
        newStartMinuteOfDay
      );


    const newStartKey =
      localDateTimeToMinuteKey(
        newStart
      );


    const newEnd =
      minuteKeyToLocalDateTime(
        newStartKey +
        duration
      );


    const movedEvent = {

      id:
        storedEvent.id,

      type:
        storedEvent.type,

      title:
        storedEvent.title,

      notes:
        storedEvent.notes,
      googleTitle:
        storedEvent.googleTitle,
      category:
        storedEvent.category,

      start:
        newStart,

      end:
        newEnd,

      recurrence:
        null

    };


    try {

      setStatus(
        t( 'saving_move' )
      );


      await api(
        '/events',
        {
          method:
            'POST',

          body:
            JSON.stringify(
              movedEvent
            )
        }
      );


      await loadWeek();

    } catch (error) {

      /*
        Conflict while dragging.

        Open the editor with the new
        proposed time and show the
        warning there.
      */

      if (
        error.status ===
          409 &&
        error.data?.code ===
          'BLOCKED_CONFLICT'
      ) {

        openEventModal(
          movedEvent
        );


        showConflictWarning(
          error.data,
          movedEvent
        );


        setStatus(
          t( 'move_conflict' )
        );


        return;

      }


      handleError(
        error
      );

    }

  }





  /* =========================================================
     SCHEDULE CLICK AND CONTEXT MENU
     ========================================================= */

  /*
    One gesture, one meaning. Left click on
    the schedule always starts a new session
    at the slot under the pointer, whether or
    not something is already there. Everything
    that acts on an existing session lives in
    the right-click menu, so a stray click can
    never edit or move real bookings.
  */

  function scheduleSlotFromPointer(
    column,
    clientY
  ) {

    const startMinuteOfDay =
      pointerMinuteOfDay(
        column,
        clientY
      );


    const start =
      dateAndMinutesToLocalDateTime(
        column.dataset.date,
        startMinuteOfDay
      );


    const startKey =
      localDateTimeToMinuteKey( start );


    return {
      start,
      end:
        minuteKeyToLocalDateTime(
          startKey + 60
        )
    };

  }


  function handleScheduleClick(
    event,
    column
  ) {

    if ( !state.isAdmin ) {

      return;

    }


    /*
      A drag that ends over the column also
      fires a click. Ignoring it here keeps
      moving a card from silently opening the
      new-session form on top of the drop.
    */

    if ( state.suppressNextScheduleClick ) {

      state.suppressNextScheduleClick = false;

      return;

    }


    if ( state.openContextMenu ) {

      closeContextMenu();

      return;

    }


    const slot =
      scheduleSlotFromPointer(
        column,
        event.clientY
      );


    /*
      Do not automatically assign Available.
      Type begins as Select One.
    */

    openEventModal( slot );

  }


  function handleScheduleContextMenu(
    event,
    column
  ) {

    if ( !state.isAdmin ) {

      return;

    }


    /*
      A right click that landed on a card is
      that card's menu, not the column's.
    */

    if (
      event.target
        .closest( '.event-card' )
    ) {

      return;

    }


    event.preventDefault();


    const slot =
      scheduleSlotFromPointer(
        column,
        event.clientY
      );


    const items = [
      {
        label:
          t( 'new_session_here' ),
        run:
          () => {

            openEventModal( slot );

          }
      }
    ];


    if ( state.clipboardEvent ) {

      items.push({
        label:
          t( 'paste_named', { name: clipboardLabel() } ),
        run:
          () => {

            pasteClipboardInto( slot );

          }
      });

    }


    openContextMenu(
      event,
      items
    );

  }


  function handleCardContextMenu(
    event,
    original,
    occurrence
  ) {

    if ( !state.isAdmin ) {

      return;

    }


    event.preventDefault();

    event.stopPropagation();


    const items = [
      {
        label:
          t( 'edit' ),
        run:
          () => {
            openEventModal(
              original,
              occurrence ||
              original
            );
          }
      },
      {
        label:
          t( 'customize' ),
        run:
          () => {
            openColorDialog(
              original,
              occurrence ||
              original
            );
          }
      },
      {
        label:
          t( 'duplicate' ),
        run:
          () => {
            copyEvent( occurrence || original );

            pasteClipboardInto({
              start:
                original.start,
              end:
                original.end
            });

          }
      },
      {
        label:
          t( 'copy' ),
        run:
          () => {
            copyEvent( occurrence || original );


            setStatus(
              t( 'copied_paste_hint' )
            );

          }
      },


      /*
        Availability is where sessions go, so its menu also offers
        the slot under the pointer - the same two verbs empty space
        gets - instead of making the admin find a bare patch of grid.
      */

      ...availabilitySlotItems(
        event,
        original
      ),

      {
        label:
          original.recurrence
            ? t( 'delete_more' )
            : t( 'delete' ),
        danger:
          true,
        run:
          () => {

            /*
              A repeating event is never deleted in one blind stroke:
              the dialog asks how far the deletion reaches - just the
              clicked block, everything from it onward, or the whole
              series. The clicked date comes from the expanded
              occurrence, not the series master, whose start is stuck
              on the anchor week.
            */

            if ( original.recurrence ) {

              confirmScopedDelete(
                original,
                occurrence ||
                original
              );

            } else {

              deleteEventById( original );

            }

          }
      }
    ];


    openContextMenu(
      event,
      items
    );

  }


  function availabilitySlotItems(
    menuEvent,
    original
  ) {

    if ( original.type !== 'AVAILABLE' ) {

      return [];

    }


    const column =
      menuEvent.target
        .closest( '.day-column' );


    if ( !column ) {

      return [];

    }


    const slot =
      scheduleSlotFromPointer(
        column,
        menuEvent.clientY
      );


    const items = [
      {
        label:
          t( 'new_session_here' ),
        run:
          () => {
            openEventModal( slot );
          }
      }
    ];


    if ( state.clipboardEvent ) {

      items.push({
        label:
          t( 'paste_named', { name: clipboardLabel() } ),
        run:
          () => {
            pasteClipboardInto( slot );
          }
      });

    }


    return items;

  }



  /*
    Copy keeps the fields that describe the
    session and deliberately drops the ones
    that place it in time, because the point
    of pasting is to put the same session
    somewhere else.
  */

  function copyEvent(
    original
  ) {

    state.clipboardEvent = {
      title:
        original.title || '',
      type:
        original.type || '',
      notes:
        original.notes || '',
      color:
        normalizeHex( original.color ),
      durationMinutes:
        Math.max(
          15,
          localDateTimeToMinuteKey(
            original.end
          ) -
          localDateTimeToMinuteKey(
            original.start
          )
        )
    };

  }


  function clipboardLabel() {

    const copied =
      state.clipboardEvent;


    if ( !copied ) {

      return '';

    }


    const name =
      copied.title ||
      copied.studentName ||
      labelFor( copied.type );


    return name.length > 24
      ? name.slice( 0, 23 ) + '…'
      : name;

  }


  /*
    Paste opens the editor rather than writing
    straight to the server, so the slot can be
    checked and adjusted before it is saved.
    Everything except date and time arrives
    already filled in.
  */

  function pasteClipboardInto(
    slot
  ) {

    const copied =
      state.clipboardEvent;


    if ( !copied ) {

      return;

    }


    const startKey =
      localDateTimeToMinuteKey(
        slot.start
      );


    openEventModal({
      start:
        slot.start,
      end:
        minuteKeyToLocalDateTime(
          startKey +
          copied.durationMinutes
        ),
      title:
        copied.title,
      type:
        copied.type,
      notes:
        copied.notes,
      googleTitle:
        copied.googleTitle,
      category:
        copied.category,
      color:
        copied.color
    });
  }


  /*
    In-page choice dialog, replacing the browser's confirm(). Resolves
    to the chosen value, or null when dismissed. Each verb sits on its
    own stacked button so a three-way decision reads as three plain
    sentences instead of an OK/Cancel riddle.
  */

  function siteDialog({
    title,
    message,
    content,
    wide,
    choices,
    cancelLabel,
    mode,
    defaultValue,
    okLabel
  }) {

    return new Promise( (resolve) => {

      const backdrop =
        document.createElement( 'div' );

      backdrop.className =
        'modal-backdrop choice-backdrop';


      const card =
        document.createElement( 'div' );

      card.className =
        'modal-card small-modal choice-modal' +
        ( wide ? ' wide-choice' : '' );

      card.setAttribute( 'role', 'alertdialog' );

      card.setAttribute( 'aria-modal', 'true' );


      const heading =
        document.createElement( 'h2' );

      heading.textContent =
        title;

      card.appendChild( heading );


      if ( message ) {
        const body =
          document.createElement( 'p' );
        body.className =
          'choice-message';
        body.textContent =
          message;
        card.appendChild( body );
      }
      /*
        A caller may put its own controls above the choices - the
        color swatches, say.
      */
      if ( content ) {
        card.appendChild( content );
      }


      const list =
        document.createElement( 'div' );

      list.className =
        'choice-list';


      let settled = false;

      const finish = (value) => {

        if ( settled ) {

          return;

        }

        settled = true;

        document.removeEventListener( 'keydown', onKey, true );

        backdrop.remove();

        resolve( value );

      };


      let selected =
        defaultValue ||
        (
          choices &&
          choices[0] &&
          choices[0].value
        );


      ( choices || [] ).forEach( (choice) => {

        if ( mode === 'radio' ) {

          /*
            Calendar-style: picking a row only selects it. The
            decision is committed by OK below, so a slip of the
            pointer costs nothing.
          */

          const row =
            document.createElement( 'label' );

          row.className =
            'choice-radio-row';


          const input =
            document.createElement( 'input' );

          input.type =
            'radio';

          input.name =
            'choice-scope';

          input.value =
            choice.value;

          input.checked =
            choice.value ===
            selected;

          input.addEventListener( 'change', () => {

            selected =
              choice.value;

          });

          row.appendChild( input );


          const text =
            document.createElement( 'span' );

          text.textContent =
            choice.label;

          row.appendChild( text );


          list.appendChild( row );


          return;

        }


        const button =
          document.createElement( 'button' );

        button.type =
          'button';

        button.className =
          'btn choice-btn' +
          ( choice.danger
            ? ' danger'
            : ' secondary' );

        button.textContent =
          choice.label;

        button.addEventListener( 'click', () => {

          finish( choice.value );

        });

        list.appendChild( button );

      });

      card.appendChild( list );


      const cancel =
        document.createElement( 'button' );

      cancel.type =
        'button';

      cancel.className =
        mode === 'radio'
          ? 'btn secondary'
          : 'btn choice-cancel';

      cancel.textContent =
        cancelLabel ||
        t( 'cancel' );

      cancel.addEventListener( 'click', () => {

        finish( null );

      });


      if ( mode === 'radio' ) {

        const actions =
          document.createElement( 'div' );

        actions.className =
          'choice-actions';


        actions.appendChild( cancel );


        const ok =
          document.createElement( 'button' );

        ok.type =
          'button';

        ok.className =
          'btn primary';

        ok.textContent =
          okLabel ||
          t( 'ok' );

        ok.addEventListener( 'click', () => {

          finish( selected );

        });

        actions.appendChild( ok );


        card.appendChild( actions );

      } else {

        card.appendChild( cancel );

      }


      /*
        Capture phase, so Escape closes this dialog without also
        reaching the app's global handler and closing whatever
        modal sits underneath it.
      */

      const onKey = (keyEvent) => {

        if ( keyEvent.key === 'Escape' ) {

          keyEvent.stopPropagation();

          finish( null );

        }

      };

      document.addEventListener( 'keydown', onKey, true );


      backdrop.addEventListener( 'mousedown', (downEvent) => {

        if ( downEvent.target === backdrop ) {

          finish( null );

        }

      });


      backdrop.appendChild( card );

      document.body.appendChild( backdrop );


      const first =
        list.querySelector( 'button, input' );

      if ( first ) {

        first.focus();

      }

    });

  }


  async function siteConfirm(
    title,
    message,
    verb
  ) {

    const choice =
      await siteDialog({
        title,
        message,
        choices: [
          {
            label:
              verb ||
              t( 'delete' ),
            value:
              'yes',
            danger:
              true
          }
        ]
      });


    return choice === 'yes';

  }


  function occurrenceLabel(
    original
  ) {

    const date =
      new Date(
        original.start.slice( 0, 10 ) + 'T12:00'
      );


    return date.toLocaleDateString(
      I18N.locale(),
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      }
    );

  }


  /*
    Date arithmetic on plain YYYY-MM-DD strings, through UTC so a DST
    boundary can never bend a day into 23 or 25 hours mid-shift.
  */

  function shiftDateString(
    dateStr,
    deltaDays
  ) {

    const [ y, m, d ] =
      dateStr
        .split( '-' )
        .map( Number );


    return new Date(
      Date.UTC(
        y,
        m - 1,
        d + deltaDays
      )
    )
      .toISOString()
      .slice( 0, 10 );

  }


  /*
    Deleting from a repeating series reaches one of three distances:
    the clicked block alone, everything from it onward, or the whole
    series. One dialog asks which; choosing the verb is the
    confirmation, so nothing asks twice. Resolves true when any
    deletion was chosen and attempted.
  */

  async function confirmScopedDelete(
    original,
    occurrence
  ) {

    const clicked =
      occurrence ||
      original;


    const choice =
      await siteDialog({
        title:
          t( 'delete_recurring' ),
        message:
          t( 'part_of_series' ) + '\n' +
          ( original.title || t( 'this_event' ) ) +
          ' — ' +
          occurrenceLabel( clicked ),
        mode:
          'radio',
        defaultValue:
          'one',
        /*
          A series that meets on several days also offers "All
          Mondays": the other days keep their sessions.
        */
        choices:
          seriesScopeChoices(
            original,
            clicked,
            {
              one: t( 'this_event_only' ),
              following: t( 'this_and_following' ),
              weekday: t( 'all_weekday' ).replace( '{weekday}', '%s' ),
              all: t( 'all_events' )
            }
          )
      });
    if ( !choice ) {
      return false;
    }
    if ( choice === 'one' ) {
      await deleteOneOccurrence(
        original,
        clicked
      );
    } else if ( choice === 'weekday' ) {
      await deleteWeekdayFromSeries(
        original,
        clicked
      );
    } else if ( choice === 'following' ) {

      await deleteFollowing(
        original,
        clicked
      );

    } else {

      await deleteWholeSeries(
        original
      );

    }


    return true;

  }


  /*
    Remove one occurrence. The series itself is untouched: the server
    records the date as an exception and every other week keeps its
    session. The status is written after loadWeek so its own progress
    narration does not stomp on the confirmation.
  */

  async function deleteOneOccurrence(
    original,
    occurrence
  ) {

    beginAction( "delete this week's session" );


    const date =
      occurrence.start.slice( 0, 10 );


    const id =
      original.masterId ||
      original.id;


    try {

      await api(
        '/events/' +
          encodeURIComponent( id ) +
          '/skip',
        {
          method:
            'POST',
          body:
            JSON.stringify({ date })
        }
      );


      await loadWeek();


      setStatus(
        t( 'removed_one', { date: occurrenceLabel( occurrence ) } )
      );

    } catch (error) {

      setStatus( error.message );

    }

  }


  /*
    Ending a series "from here on" is a truncation, not a deletion:
    the master keeps everything it had but gains an end date the day
    before the chosen block, so earlier weeks survive exactly as they
    were. The master's own start and times come from seriesStart and
    seriesEnd - the clicked card is an expanded occurrence whose start
    belongs to the viewed week, and saving THAT as the anchor would
    silently erase the history being protected.
  */

  async function deleteFollowing(
    original,
    occurrence
  ) {

    beginAction( 'delete this and following sessions' );


    const cut =
      occurrence.start.slice( 0, 10 );


    const masterStart =
      original.seriesStart ||
      original.start;


    const masterEnd =
      original.seriesEnd ||
      original.end;


    if (
      cut <=
      masterStart.slice( 0, 10 )
    ) {

      /*
        Cutting at the very first block leaves nothing - that is the
        whole-series case wearing different clothes.
      */

      await deleteWholeSeries(
        original
      );


      return;

    }


    const recurrence = {

      frequency:
        'WEEKLY',

      interval:
        original.recurrence.interval ||
        1,

      weekdays:
        original.recurrence.weekdays,

      endType:
        'ON',

      until:
        shiftDateString(
          cut,
          -1
        )

    };


    if ( original.recurrence.exdates ) {

      recurrence.exdates =
        original.recurrence.exdates;

    }


    try {

      await api(
        '/events',
        {
          method:
            'POST',
          body:
            JSON.stringify({

              /*
                Ending a series early only removes sessions, so this
                never waits on the conflict check.
              */

              forceConflict:
                true,

              id:
                original.masterId ||
                original.id,

              type:
                original.type,

              title:
                original.title,

              notes:
                original.notes,
              googleTitle:
                original.googleTitle,
              category:
                original.category,

              start:
                masterStart,

              end:
                masterEnd,

              recurrence

            })
        }
      );


      await loadWeek();


      setStatus(
        t( 'removed_following', { date: occurrenceLabel( occurrence ) } )
      );

    } catch (error) {

      setStatus( error.message );

    }

  }


  async function deleteWholeSeries(
    original
  ) {

    beginAction( 'delete the whole series' );


    const id =
      original.masterId ||
      original.id;


    try {

      await api(
        '/events/' +
          encodeURIComponent( id ),
        {
          method:
            'DELETE'
        }
      );


      await loadWeek();


      setStatus(
        t( 'series_deleted' )
      );

    } catch (error) {

      setStatus( error.message );

    }

  }


  /* =========================================================
     EDITING A REPEATING BLOCK WITH SCOPE
  ========================================================= */

  /*
    The editor's save on a series, routed by the same radio dialog.
    Returns the status line to show on success, false when cancelled
    or failed - failure writes into the modal's own error line so the
    editor stays open with everything the admin typed.
  */

  /*
    The series behind the editor, wherever the editor was opened from.
    This week's loaded events are the first place to look; failing
    that, the record the editor was opened with (the Blocked Sessions
    list hands over occurrences from other weeks); failing that, the
    server, for the week on the form. Returns null when the id is not
    a series at all, so the caller keeps its plain path.
  */

  async function resolveEditingSeries(
    id
  ) {

    const loaded =
      getOriginalEvent({
        id
      });


    let original =
      loaded?.recurrence
        ? loaded
        : null;


    const opened =
      state.editingEvent;


    if (
      !original &&
      opened?.recurrence &&
      (
        opened.masterId ||
        opened.id
      ) === id
    ) {

      original =
        opened;

    }


    if ( !original ) {

      const date =
        $('eventStartDate').value;


      if ( date ) {

        try {

          const data =
            await api(
              `/events?start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`
            );


          original =
            (
              data.events ||
              []
            ).find(
              (item) =>
                (
                  item.masterId ||
                  item.id
                ) === id &&
                item.recurrence
            ) ||
            null;

        } catch {

          original =
            null;

        }

      }

    }


    if ( !original ) {

      return null;

    }


    /*
      "Just this one" means the block that was opened: the clicked
      card when there was one, else the record the editor holds if it
      is a dated occurrence of this series, else the master itself.
    */

    const occurrence =
      state.editingOccurrence ||
      (
        opened &&
        opened.masterId === id
          ? opened
          : original
      );


    return {
      original,
      occurrence
    };

  }


  async function saveSeriesEditWithScope(
    formEvent,
    chosenScope
  ) {

    const series =
      await resolveEditingSeries(
        formEvent.id
      );


    const original =
      series.original;
    const occurrence =
      series.occurrence;
    if (
      onlyColorChanged(
        original,
        occurrence,
        formEvent
      )
    ) {
      const reach =
        await siteDialog({
          title:
            t( 'customize_recurring' ),
          mode:
            'radio',
          defaultValue:
            'one',
          choices:
            seriesScopeChoices(
              original,
              occurrence,
              {
                one: t( 'this_event_only' ),
                following: t( 'this_and_following' ),
                weekday: t( 'all_weekday' ).replace( '{weekday}', '%s' ),
                all: t( 'all_in_series' )
              }
            )
        });
      if ( !reach ) {
        return false;
      }
      try {
        return await requestColor(
          original.masterId ||
            original.id,
          formEvent.color,
          reach,
          occurrence
        );
      } catch (error) {
        $('eventError')
          .textContent =
            error.message ||
            t( 'change_failed' );
        return false;
      }
    }
    const scope =
      chosenScope ||
      await siteDialog({
        title:
          t( 'edit_recurring' ),
        mode:
          'radio',
        defaultValue:
          'one',
        choices: [
          {
            label:
              t( 'this_event_only' ),
            value:
              'one'
          },
          {
            label:
              t( 'this_and_following' ),
            value:
              'following'
          },
          {
            label:
              t( 'all_events' ),
            value:
              'all'
          }
        ]
      });


    if ( !scope ) {

      return false;

    }


    try {

      if ( scope === 'one' ) {

        return await applyEditToOneOccurrence(
          original,
          occurrence,
          formEvent
        );

      }


      if ( scope === 'following' ) {

        return await applyEditToFollowing(
          original,
          occurrence,
          formEvent
        );

      }


      return await applyEditToWholeSeries(
        original,
        occurrence,
        formEvent
      );

    } catch (error) {

      /*
        An overlap is the admin's call, as it is for a one-off: the
        form shows which sessions clash and offers Save anyway, which
        re-runs this same scope with the check waived.
      */
      if (
        error?.data?.code ===
        'BLOCKED_CONFLICT'
      ) {

        showConflictWarning(
          error.data,
          {
            ...formEvent,
            seriesScope:
              scope
          }
        );


        return false;

      }


      $('eventError')
        .textContent =
          error.message ||
          t( 'change_failed' );


      return false;

    }

  }


  /*
    One week steps out of line: the series records an exception on
    the clicked date and a standalone event carries the edited
    fields. If the standalone cannot be saved the exception is rolled
    back, so a failed edit never deletes the week.
  */

  async function applyEditToOneOccurrence(
    original,
    occurrence,
    formEvent
  ) {

    beginAction( "edit this week's session" );


    const id =
      original.masterId ||
      original.id;


    await api(
      '/events/' +
        encodeURIComponent( id ) +
        '/skip',
      {
        method:
          'POST',
        body:
          JSON.stringify({
            date:
              occurrence.start.slice( 0, 10 )
          })
      }
    );


    try {

      await api(
        '/events',
        {
          method:
            'POST',
          body:
            JSON.stringify({
              forceConflict:
                formEvent.forceConflict === true,
              type:
                formEvent.type,
              title:
                formEvent.title,
              notes:
                formEvent.notes,
              googleTitle:
                formEvent.googleTitle,
              category:
                formEvent.category,
              start:
                formEvent.start,
              end:
                formEvent.end,
              recurrence:
                null,
              color:
                'color' in formEvent
                  ? formEvent.color
                  : ( normalizeHex( occurrence.color ) || null )
            })
        }
      );

    } catch (error) {

      await repostMaster(
        original
      );


      throw error;

    }


    return t( 'changed_one', { date: occurrenceLabel( occurrence ) } );

  }


  /*
    From the clicked week on, the series follows the edited fields:
    the old master ends the day before the cut and a new series
    starts from the form exactly as typed. Earlier weeks keep the
    old shape.
  */

  async function applyEditToFollowing(
    original,
    occurrence,
    formEvent
  ) {

    beginAction( 'edit this and following sessions' );


    const cut =
      occurrence.start.slice( 0, 10 );


    const masterStart =
      original.seriesStart ||
      original.start;


    if (
      cut <=
      masterStart.slice( 0, 10 )
    ) {

      return await applyEditToWholeSeries(
        original,
        occurrence,
        formEvent
      );

    }


    const truncated = {

      frequency:
        'WEEKLY',

      interval:
        original.recurrence.interval ||
        1,

      weekdays:
        original.recurrence.weekdays,

      endType:
        'ON',

      until:
        shiftDateString(
          cut,
          -1
        )

    };


    if ( original.recurrence.exdates ) {

      truncated.exdates =
        original.recurrence.exdates;

    }


    await api(
      '/events',
      {
        method:
          'POST',
        body:
          JSON.stringify(
            masterPayload(
              original,
              truncated
            )
          )
      }
    );


    try {

      await api(
        '/events',
        {
          method:
            'POST',
          body:
            JSON.stringify({
              forceConflict:
                formEvent.forceConflict === true,
              type:
                formEvent.type,
              title:
                formEvent.title,
              notes:
                formEvent.notes,
              googleTitle:
                formEvent.googleTitle,
              category:
                formEvent.category,
              start:
                formEvent.start,
              end:
                formEvent.end,
              recurrence:
                formEvent.recurrence,
              color:
                'color' in formEvent
                  ? formEvent.color
                  : ( normalizeHex( occurrence.color ) || null )
            })
        }
      );

    } catch (error) {

      await repostMaster(
        original
      );


      throw error;

    }


    return t( 'changed_following', { date: occurrenceLabel( occurrence ) } );

  }


  /*
    The whole series takes the edited fields while keeping its own
    anchor: the form's date is read as a shift relative to the
    clicked week and applied to the series start, so history does not
    silently re-anchor to whichever week happened to be on screen.
    Exception dates ride along, shifted by the same days.
  */

  async function applyEditToWholeSeries(
    original,
    occurrence,
    formEvent
  ) {

    beginAction( 'edit the whole series' );


    const dayDelta =
      dayNumber(
        formEvent.start.slice( 0, 10 )
      ) -
      dayNumber(
        occurrence.start.slice( 0, 10 )
      );


    const masterStart =
      original.seriesStart ||
      original.start;


    const newStart =
      shiftDateString(
        masterStart.slice( 0, 10 ),
        dayDelta
      ) +
      formEvent.start.slice( 10 );


    const duration =
      localDateTimeToMinuteKey(
        formEvent.end
      ) -
      localDateTimeToMinuteKey(
        formEvent.start
      );


    const newEnd =
      minuteKeyToLocalDateTime(
        localDateTimeToMinuteKey(
          newStart
        ) +
        duration
      );


    const recurrence = {
      ...formEvent.recurrence
    };


    const oldExdates =
      original.recurrence.exdates ||
      [];


    if ( oldExdates.length ) {

      recurrence.exdates =
        oldExdates.map(
          (exdate) =>
            shiftDateString(
              exdate,
              dayDelta
            )
        );

    }


    await api(
      '/events',
      {
        method:
          'POST',
        body:
          JSON.stringify({
            forceConflict:
              formEvent.forceConflict === true,
            id:
              original.masterId ||
              original.id,
            type:
              formEvent.type,
            title:
              formEvent.title,
            notes:
              formEvent.notes,
            googleTitle:
              formEvent.googleTitle,
            category:
              formEvent.category,
            start:
              newStart,
            end:
              newEnd,
            recurrence,
            ...(
              'color' in formEvent
                ? { color: formEvent.color }
                : {}
            )
          })
      }
    );


    return t( 'changed_all' );

  }


  /* =========================================================
     MOVING A REPEATING BLOCK
  ========================================================= */

  /*
    The master record rebuilt for saving: id and times from the
    series' own anchor (seriesStart/seriesEnd), never from an
    expanded occurrence, whose start belongs to whatever week was
    on screen.
  */

  function masterPayload(
    original,
    recurrence
  ) {

    return {

      /*
        Every use of this is a truncation or a rollback: the series is
        re-saved shortened, or restored exactly as it was. Neither can
        introduce a clash, so neither waits on the conflict check -
        which otherwise refuses the internal save and leaves the admin
        told that a deletion "overlaps an existing blocked session".
      */

      forceConflict:
        true,

      id:
        original.masterId ||
        original.id,

      type:
        original.type,

      title:
        original.title,

      notes:
        original.notes,
      googleTitle:
        original.googleTitle,
      category:
        original.category,

      start:
        original.seriesStart ||
        original.start,

      end:
        original.seriesEnd ||
        original.end,

      recurrence

    };

  }


  async function repostMaster(
    original
  ) {

    await api(
      '/events',
      {
        method:
          'POST',
        body:
          JSON.stringify(
            masterPayload(
              original,
              original.recurrence
            )
          )
      }
    );

  }


  function dayNumber(
    dateStr
  ) {

    return Math.floor(
      Date.parse(
        dateStr +
        'T00:00:00Z'
      ) /
      86400000
    );

  }


  function utcWeekday(
    dateStr
  ) {

    return new Date(
      dateStr +
      'T00:00:00Z'
    ).getUTCDay();

  }


  /*
    How many occurrences the series delivers strictly before a date.
    Exception dates still count - a skipped week consumes its slot in
    a COUNT series rather than extending it - so this walks the bare
    weekday-and-interval pattern, matching the server's bookkeeping.
  */

  function occurrencesBefore(
    original,
    cut
  ) {

    const recurrence =
      original.recurrence;


    const startDate =
      (
        original.seriesStart ||
        original.start
      ).slice( 0, 10 );


    const interval =
      recurrence.interval ||
      1;


    const anchorWeekStart =
      dayNumber( startDate ) -
      utcWeekday( startDate );


    let count = 0;


    for (
      let day = dayNumber( startDate );
      day < dayNumber( cut );
      day++
    ) {

      const weekday =
        ( day + 4 ) %
        7;


      const weeks =
        Math.floor(
          (
            day -
            anchorWeekStart
          ) /
          7
        );


      if (
        recurrence.weekdays.includes( weekday ) &&
        weeks %
          interval ===
          0
      ) {

        count++;

      }

    }


    return count;

  }


  function moveErrorText(
    error
  ) {

    return error?.data?.code ===
      'BLOCKED_CONFLICT'
      ? t( 'move_not_saved_overlap' )
      : (
          error.message ||
          t( 'move_failed' )
        );

  }


  function moveTargetLabel(
    localDateTime
  ) {

    return new Date(
      localDateTime
    ).toLocaleString(
      I18N.locale(),
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour12: !is24h(),
        hour: 'numeric',
        minute: '2-digit'
      }
    );

  }


  /*
    Dropping a repeating block asks the same three-reach question as
    deleting one: just this block, this and every one after, or the
    whole series. The dialog opens after the drop, with the landing
    time in its message, and Cancel puts everything back.
  */

  async function moveRecurringDrop(
    original,
    occurrence,
    column,
    dropEvent
  ) {

    const occStartKey =
      localDateTimeToMinuteKey(
        occurrence.start
      );


    const duration =
      localDateTimeToMinuteKey(
        occurrence.end
      ) -
      occStartKey;


    const newStart =
      dateAndMinutesToLocalDateTime(
        column.dataset.date,
        pointerMinuteOfDay(
          column,
          dropEvent.clientY
        )
      );


    const newStartKey =
      localDateTimeToMinuteKey(
        newStart
      );


    const newEnd =
      minuteKeyToLocalDateTime(
        newStartKey +
        duration
      );


    if (
      newStart ===
      occurrence.start
    ) {

      return;

    }


    const dayDelta =
      dayNumber(
        column.dataset.date
      ) -
      dayNumber(
        occurrence.start.slice( 0, 10 )
      );


    const timeDelta =
      newStartKey -
      occStartKey -
      dayDelta *
      1440;


    const choice =
      await siteDialog({
        title:
          t( 'edit_recurring' ),
        message:
          ( original.title || t( 'this_event' ) ) +
          ' would land on ' +
          moveTargetLabel( newStart ) +
          '.',
        mode:
          'radio',
        defaultValue:
          'one',
        choices: [
          {
            label:
              t( 'this_event_only' ),
            value:
              'one'
          },
          {
            label:
              t( 'this_and_following' ),
            value:
              'following'
          },
          {
            label:
              t( 'all_events' ),
            value:
              'all'
          }
        ]
      });


    if ( !choice ) {

      return;

    }


    if ( choice === 'one' ) {

      await moveOneOccurrence(
        original,
        occurrence,
        newStart,
        newEnd
      );

    } else if ( choice === 'following' ) {

      await moveFollowing(
        original,
        occurrence,
        newStart,
        newEnd,
        dayDelta,
        timeDelta
      );

    } else {

      await moveWholeSeries(
        original,
        occurrence,
        dayDelta,
        timeDelta
      );

    }

  }


  /*
    One block steps out of line: the series records an exception on
    the old date and a standalone event appears at the new time. If
    the standalone cannot be saved - a conflict, say - the exception
    is rolled back, so a failed move never silently deletes the week.
  */

  async function moveOneOccurrence(
    original,
    occurrence,
    newStart,
    newEnd
  ) {

    beginAction( "move this week's session" );


    const id =
      original.masterId ||
      original.id;


    const date =
      occurrence.start.slice( 0, 10 );


    try {

      setStatus(
        t( 'moving_one' )
      );


      await api(
        '/events/' +
          encodeURIComponent( id ) +
          '/skip',
        {
          method:
            'POST',
          body:
            JSON.stringify({ date })
        }
      );


      try {

        await api(
          '/events',
          {
            method:
              'POST',
            body:
              JSON.stringify({

                type:
                  original.type,

                title:
                  original.title,

                notes:
                  original.notes,
                googleTitle:
                  original.googleTitle,
                category:
                  original.category,

                color:
                  normalizeHex( occurrence.color ) || null,

                start:
                  newStart,

                end:
                  newEnd,

                recurrence:
                  null

              })
          }
        );

      } catch (error) {

        await repostMaster(
          original
        );


        throw error;

      }


      await loadWeek();


      setStatus(
        t( 'moved_one', { date: occurrenceLabel( occurrence ) } )
      );

    } catch (error) {

      await loadWeek();


      setStatus(
        moveErrorText( error )
      );

    }

  }


  /*
    From here on, the series happens at the new time: the old master
    is truncated the day before the cut, and a new series starts at
    the landing time carrying the rest of the pattern. The dragged
    weekday follows the drop; the series' other weekdays stay put. A
    COUNT series hands the new one only the occurrences it had left,
    and exception dates on the moved weekday travel with it.
  */

  async function moveFollowing(
    original,
    occurrence,
    newStart,
    newEnd,
    dayDelta,
    timeDelta
  ) {

    beginAction( 'move this and following sessions' );


    const cut =
      occurrence.start.slice( 0, 10 );


    const masterStartDate =
      (
        original.seriesStart ||
        original.start
      ).slice( 0, 10 );


    if (
      cut <=
      masterStartDate
    ) {

      /*
        Cutting at the first block means the whole series moves.
      */

      await moveWholeSeries(
        original,
        occurrence,
        dayDelta,
        timeDelta
      );


      return;

    }


    const recurrence =
      original.recurrence;


    const oldWeekday =
      utcWeekday( cut );


    const newWeekday =
      utcWeekday(
        newStart.slice( 0, 10 )
      );


    const movedRecurrence = {

      frequency:
        'WEEKLY',

      interval:
        recurrence.interval ||
        1,

      weekdays:
        [ ...new Set(
          recurrence.weekdays.map(
            (weekday) =>
              weekday ===
              oldWeekday
                ? newWeekday
                : weekday
          )
        ) ].sort(
          (a, b) =>
            a - b
        ),

      endType:
        recurrence.endType ||
        'NEVER'

    };


    if (
      recurrence.endType ===
      'ON'
    ) {

      movedRecurrence.until =
        recurrence.until >=
        newStart.slice( 0, 10 )
          ? recurrence.until
          : newStart.slice( 0, 10 );

    }


    if (
      recurrence.endType ===
      'COUNT'
    ) {

      movedRecurrence.count =
        Math.max(
          1,
          recurrence.count -
          occurrencesBefore(
            original,
            cut
          )
        );

    }


    const carriedExdates =
      ( recurrence.exdates || [] )
        .filter(
          (exdate) =>
            exdate >=
            cut
        )
        .map(
          (exdate) =>
            utcWeekday( exdate ) ===
            oldWeekday
              ? shiftDateString(
                  exdate,
                  dayDelta
                )
              : exdate
        );


    if ( carriedExdates.length ) {

      movedRecurrence.exdates =
        carriedExdates;

    }


    const truncated = {

      frequency:
        'WEEKLY',

      interval:
        recurrence.interval ||
        1,

      weekdays:
        recurrence.weekdays,

      endType:
        'ON',

      until:
        shiftDateString(
          cut,
          -1
        )

    };


    if ( recurrence.exdates ) {

      truncated.exdates =
        recurrence.exdates;

    }


    try {

      setStatus(
        t( 'moving_following' )
      );


      await api(
        '/events',
        {
          method:
            'POST',
          body:
            JSON.stringify(
              masterPayload(
                original,
                truncated
              )
            )
        }
      );


      try {

        await api(
          '/events',
          {
            method:
              'POST',
            body:
              JSON.stringify({

                type:
                  original.type,

                title:
                  original.title,

                notes:
                  original.notes,
                googleTitle:
                  original.googleTitle,
                category:
                  original.category,

                color:
                  normalizeHex( occurrence.color ) || null,

                start:
                  newStart,

                end:
                  newEnd,

                recurrence:
                  movedRecurrence

              })
          }
        );

      } catch (error) {

        await repostMaster(
          original
        );


        throw error;

      }


      await loadWeek();


      setStatus(
        t( 'moved_following', { date: occurrenceLabel( occurrence ) } )
      );

    } catch (error) {

      await loadWeek();


      setStatus(
        moveErrorText( error )
      );

    }

  }


  /*
    The whole series shifts by the same distance the block was
    dragged - day and minutes alike, past weeks included. The dragged
    weekday moves in the pattern; the others stay. Exception dates on
    the moved weekday shift with it, and an ON end date slides by the
    same days so the series keeps its length.
  */

  async function moveWholeSeries(
    original,
    occurrence,
    dayDelta,
    timeDelta
  ) {

    beginAction( 'move the whole series' );


    const recurrence =
      original.recurrence;


    const masterStart =
      original.seriesStart ||
      original.start;


    const masterEnd =
      original.seriesEnd ||
      original.end;


    const shiftBy =
      dayDelta *
      1440 +
      timeDelta;


    const oldWeekday =
      utcWeekday(
        occurrence.start.slice( 0, 10 )
      );


    const newWeekday =
      (
        (
          oldWeekday +
          dayDelta
        ) %
        7 +
        7
      ) %
      7;


    const movedRecurrence = {

      frequency:
        'WEEKLY',

      interval:
        recurrence.interval ||
        1,

      weekdays:
        [ ...new Set(
          recurrence.weekdays.map(
            (weekday) =>
              weekday ===
              oldWeekday
                ? newWeekday
                : weekday
          )
        ) ].sort(
          (a, b) =>
            a - b
        ),

      endType:
        recurrence.endType ||
        'NEVER'

    };


    if (
      recurrence.endType ===
      'ON'
    ) {

      movedRecurrence.until =
        shiftDateString(
          recurrence.until,
          dayDelta
        );

    }


    if (
      recurrence.endType ===
      'COUNT'
    ) {

      movedRecurrence.count =
        recurrence.count;

    }


    if ( recurrence.exdates ) {

      movedRecurrence.exdates =
        recurrence.exdates.map(
          (exdate) =>
            utcWeekday( exdate ) ===
            oldWeekday
              ? shiftDateString(
                  exdate,
                  dayDelta
                )
              : exdate
        );

    }


    try {

      setStatus(
        t( 'moving_all' )
      );


      await api(
        '/events',
        {
          method:
            'POST',
          body:
            JSON.stringify({

              id:
                original.masterId ||
                original.id,

              type:
                original.type,

              title:
                original.title,

              notes:
                original.notes,
              googleTitle:
                original.googleTitle,
              category:
                original.category,

              start:
                minuteKeyToLocalDateTime(
                  localDateTimeToMinuteKey(
                    masterStart
                  ) +
                  shiftBy
                ),

              end:
                minuteKeyToLocalDateTime(
                  localDateTimeToMinuteKey(
                    masterEnd
                  ) +
                  shiftBy
                ),

              recurrence:
                movedRecurrence

            })
        }
      );


      await loadWeek();


      setStatus(
        t( 'moved_all' )
      );

    } catch (error) {

      await loadWeek();


      setStatus(
        moveErrorText( error )
      );

    }

  }


  async function deleteEventById(
    original
  ) {

    beginAction( 'delete session' );


    const id =
      original.masterId ||
      original.id;


    if ( !id ) {

      return;

    }


    const wanted =
      await siteConfirm(
        original.recurrence
          ? t( 'delete_series_q' )
          : t( 'delete_event_q' ),
        original.title ||
        ''
      );


    if ( !wanted ) {

      return;

    }


    try {

      await api(
        '/events/' +
          encodeURIComponent( id ),
        {
          method:
            'DELETE'
        }
      );


      await loadWeek();

    } catch (error) {

      setStatus( error.message );

    }

  }


  /* -----------------------------
     THE MENU ITSELF
  ----------------------------- */

  function openContextMenu(
    event,
    items
  ) {

    closeContextMenu();


    const menu =
      document
        .createElement( 'div' );


    menu.className = 'context-menu';


    menu
      .setAttribute(
        'role',
        'menu'
      );


    items
      .forEach(
        (item) => {

          const button =
            document
              .createElement( 'button' );


          button.type = 'button';

          button.className =
            'context-menu-item' +
            ( item.danger
              ? ' is-danger'
              : '' );

          button.textContent =
            item.label;


          button
            .addEventListener(
              'click',
              (clickEvent) => {

                clickEvent
                  .stopPropagation();

                closeContextMenu();

                item.run();

              }
            );


          menu.appendChild( button );

        }
      );


    document
      .body
      .appendChild( menu );


    /*
      Keep the menu on screen: flip it back
      inside the viewport if opening at the
      pointer would push it off an edge.
    */

    const width =
      menu.offsetWidth;


    const height =
      menu.offsetHeight;


    const left =
      Math.min(
        event.clientX,
        window.innerWidth - width - 8
      );


    const top =
      Math.min(
        event.clientY,
        window.innerHeight - height - 8
      );


    menu.style.left =
      Math.max( 8, left ) + 'px';

    menu.style.top =
      Math.max( 8, top ) + 'px';


    state.openContextMenu = menu;

  }


  function closeContextMenu() {

    if ( state.openContextMenu ) {

      state.openContextMenu.remove();

      state.openContextMenu = null;

    }

  }




  /* =========================================================
     ADMIN LOGIN
  ========================================================= */


  /* =========================================================
     SESSION REQUESTS (PUBLIC)
  ========================================================= */


  /* =========================================================
     DATE AND TIME FIELDS
  ========================================================= */

  /*
    Each start and end is a visible date input
    and a visible time input, plus a hidden
    field holding the combined value the rest
    of the app already reads and listens to.

    Splitting them is what lets a phone open
    the time wheel on the first tap. Keeping
    the hidden field means nothing downstream
    has to know that happened.
  */

  function setDateTimeValue(
    id,
    value
  ) {

    const combined =
      value ||
      '';


    $(id)
      .value =
        combined;


    $(id + 'Date')
      .value =
        combined
          .slice(
            0,
            10
          );


    writeTimeControl(
      id,
      combined
        .slice(
          11,
          16
        )
    );

  }



  function bindDateTimeField(
    id
  ) {

    const recombine =
      () => {

        const date =
          $(id + 'Date')
            .value;


        const time =
          $(id + 'Time')
            .value;


        /*
          Half a value is not a time. Leaving
          it empty keeps the existing
          validation in charge of saying so.
        */

        $(id)
          .value =
            date &&
            time
              ? `${date}T${time.slice(0, 5)}`
              : '';


        /*
          The hidden field is what listeners
          were attached to, so tell them it
          moved.
        */

        $(id)
          .dispatchEvent(
            new Event(
              'change',
              {
                bubbles:
                  true
              }
            )
          );


        $(id)
          .dispatchEvent(
            new Event(
              'input',
              {
                bubbles:
                  true
              }
            )
          );

      };


    bindTimeControl(
      id
    );


    /*
      The year segment of a native date input
      accepts six digits, and min/max only
      mark the field invalid rather than stop
      the typing. A schedule has no business
      in the year 275760, so anything outside
      the allowed span is pulled back to it
      once the field is left.
    */

    $(id + 'Date')
      .addEventListener(
        'blur',
        () => {

          const field =
            $(id + 'Date');


          if ( !field.value ) {

            return;

          }


          const year =
            Number(
              field.value
                .slice( 0, 4 )
            );


          if (
            !Number.isFinite( year ) ||
            ( year >= 2000 &&
              year <= 2099 )
          ) {

            return;

          }


          const clamped =
            Math.min(
              2099,
              Math.max( 2000, year )
            );


          field.value =
            String( clamped ) +
            field.value
              .slice( 4 );


          field
            .dispatchEvent(
              new Event(
                'input',
                {
                  bubbles:
                    true
                }
              )
            );

        }
      );



    [
      id + 'Date',
      id + 'Time'
    ]
      .forEach(
        (part) => {

          $(part)
            .addEventListener(
              'change',
              recombine
            );


          $(part)
            .addEventListener(
              'input',
              recombine
            );

        }
      );

  }


  /* =========================================================
     SEGMENTED TIME CONTROL
     ========================================================= */

  /*
    A native time input cannot do everything
    this portal needs at once: typing any
    minute, a wheel that offers only quarter
    hours, and both of those on a phone. The
    step attribute governs typing and the
    picker together, so one of the three
    always loses. Three small text inputs plus
    a list of our own get all three, and the
    hidden field underneath still carries the
    same HH:MM the rest of the app reads.
  */

  const QUARTER_MINUTES = 15;


  function timeControlParts(
    id
  ) {

    return {
      hour: $(id + 'Hour'),
      minute: $(id + 'Minute'),
      meridiem: $(id + 'Meridiem'),
      hidden: $(id + 'Time')
    };

  }


  /*
    Segments to HH:MM. Returns '' unless all
    three are filled, because half a time is
    not a time and the existing validation
    should be the thing that says so.
  */

  function readTimeControl(
    id
  ) {

    const parts =
      timeControlParts( id );


    const hour =
      Number(
        parts.hour.value
      );


    const minute =
      Number(
        parts.minute.value
      );


    const meridiem =
      parts.meridiem
        .value
        .trim()
        .toUpperCase();


        if ( is24h() ) {
      if (
        !parts.hour.value ||
        !parts.minute.value ||
        !Number.isFinite( hour ) ||
        !Number.isFinite( minute ) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return '';
      }
      return (
        String( hour )
          .padStart( 2, '0' ) +
        ':' +
        String( minute )
          .padStart( 2, '0' )
      );
    }


    if (
      !parts.hour.value ||
      !parts.minute.value ||
      !Number.isFinite( hour ) ||
      !Number.isFinite( minute ) ||
      hour < 1 ||
      hour > 12 ||
      minute < 0 ||
      minute > 59 ||
      ( meridiem !== 'AM' &&
        meridiem !== 'PM' )
    ) {

      return '';

    }


    const hour24 =
      meridiem === 'AM'
        ? hour % 12
        : ( hour % 12 ) + 12;



    return (
      String( hour24 )
        .padStart( 2, '0' ) +
      ':' +
      String( minute )
        .padStart( 2, '0' )
    );

  }


  /*
    HH:MM into the three segments. An empty
    value clears them rather than showing a
    misleading 12:00 AM.
  */

  function writeTimeControl(
    id,
    value
  ) {

    const parts =
      timeControlParts( id );


    const match =
      /^(\d{1,2}):(\d{2})/
        .exec( value || '' );


    if ( !match ) {

      parts.hour.value = '';
      parts.minute.value = '';
      parts.meridiem.value = '';
      parts.hidden.value = '';

      return;

    }


    const hour24 =
      Number( match[1] );


    const minute =
      Number( match[2] );


        parts.hour.value =
      is24h()
        ? String( hour24 ).padStart( 2, '0' )
        : String(
            hour24 % 12 === 0
              ? 12
              : hour24 % 12
          );



    parts.minute.value =
      String( minute )
        .padStart( 2, '0' );


    parts.meridiem.value =
      hour24 >= 12
        ? 'PM'
        : 'AM';


    parts.hidden.value =
      String( hour24 )
        .padStart( 2, '0' ) +
      ':' +
      String( minute )
        .padStart( 2, '0' );

  }


  function bindTimeControl(
    id
  ) {

    const parts =
      timeControlParts( id );


    /*
      The hidden field is what the recombine
      logic already listens to, so every
      segment change republishes it there.
    */

    const publish =
      () => {

        parts.hidden.value =
          readTimeControl( id );


        parts.hidden
          .dispatchEvent(
            new Event(
              'input',
              {
                bubbles:
                  true
              }
            )
          );

      };


    const focusNext =
      (field) => {

        field.focus();
        field.select();

      };


    /*
      Hour: two digits, or one digit that
      cannot become a valid two-digit hour,
      moves to the minutes. Typing 1 waits,
      because 11 and 12 are still reachable;
      typing 3 does not, because there is no
      hour 3x.
    */

    parts.hour
      .addEventListener(
        'input',
        () => {

          const digits =
            parts.hour
              .value
              .replace( /\D/g, '' )
              .slice( 0, 2 );


          parts.hour.value = digits;


          publish();


          if ( digits.length === 2 ) {

            focusNext( parts.minute );

            return;

          }


                    if (
            digits.length === 1 &&
            Number( digits ) > ( is24h() ? 2 : 1 )
          ) {
            focusNext( parts.minute );
          }

        }
      );


    /*
      Minutes: any value 00-59, so 11:07 is
      typeable. Two digits move on to AM/PM.
    */

    parts.minute
      .addEventListener(
        'input',
        () => {

          const digits =
            parts.minute
              .value
              .replace( /\D/g, '' )
              .slice( 0, 2 );


                    parts.minute.value = digits;
          publish();
          if ( digits.length === 2 && !is24h() ) {
            focusNext( parts.meridiem );
          }

        }
      );


    /*
      Meridiem takes a or p from anywhere in
      what was typed, so both 'a' and 'AM'
      work and nothing else sticks.
    */

    parts.meridiem
      .addEventListener(
        'input',
        () => {

          const typed =
            parts.meridiem
              .value
              .toUpperCase();


          if ( /P/.test( typed ) ) {

            parts.meridiem.value = 'PM';

          } else if ( /A/.test( typed ) ) {

            parts.meridiem.value = 'AM';

          } else {

            parts.meridiem.value = '';

          }


          publish();

        }
      );


    /*
      Backspace at the start of a segment goes
      back to the previous one, which is what
      a native segmented field does.
    */

    [
      [ parts.minute, parts.hour ],
      [ parts.meridiem, parts.minute ]
    ]
      .forEach(
        ([ field, previous ]) => {

          field
            .addEventListener(
              'keydown',
              (keyEvent) => {

                if (
                  keyEvent.key !==
                    'Backspace' ||
                  field.value !== ''
                ) {

                  return;

                }


                keyEvent.preventDefault();

                focusNext( previous );

              }
            );

        }
      );


    /*
      Tidy up on the way out: a lone 7 in the
      minutes means 07, and an hour of 0 means
      12. Done on blur rather than on input so
      it never fights what is being typed.
    */

    [
      parts.hour,
      parts.minute
    ]
      .forEach(
        (field) => {

          field
            .addEventListener(
              'blur',
              () => {

                if ( field.value === '' ) {

                  return;

                }


                let numeric =
                  Number( field.value );


                if ( field === parts.hour && is24h() ) {

                  if ( numeric > 23 ) {

                    numeric = 23;

                  }


                  field.value =
                    String( numeric ).padStart( 2, '0' );

                } else if ( field === parts.hour ) {

                  if ( numeric === 0 ) {

                    numeric = 12;

                  }


                  if ( numeric > 12 ) {

                    numeric = 12;

                  }


                  field.value =
                    String( numeric );

                } else {

                  if ( numeric > 59 ) {

                    numeric = 59;

                  }


                  field.value =
                    String( numeric )
                      .padStart( 2, '0' );

                }


                publish();

              }
            );

        }
      );


    /*
      Selecting the whole segment on focus
      means typing replaces rather than
      appends, so a second visit to the field
      does not produce 1111.
    */

    [
      parts.hour,
      parts.minute,
      parts.meridiem
    ]
      .forEach(
        (field) => {

          field
            .addEventListener(
              'focus',
              () => {

                field.select();

              }
            );

        }
      );


    /*
      Opened on pointerdown, and toggled, so
      the global dismiss handler that runs in
      the capture phase cannot close it in the
      same gesture that asked for it.
    */

    /*
      The control sits inside a <label>, and a
      label forwards clicks to its input as a
      second, synthetic event whose target is
      the label itself. That synthetic click
      bubbles to the schedule and to the
      global dismiss handler, which would shut
      the wheel in the same gesture that
      opened it. Stopping the gesture dead at
      pointerdown, and again at click, is what
      keeps it open.
    */

    [ 'pointerdown', 'mousedown', 'click' ]
      .forEach(
        (type) => {

          $(id + 'Wheel')
            .addEventListener(
              type,
              (gestureEvent) => {

                gestureEvent
                  .preventDefault();

                gestureEvent
                  .stopPropagation();


                if ( type !== 'pointerdown' ) {

                  return;

                }


                if (
                  state.openTimeWheel === id
                ) {

                  closeTimeWheel();

                  return;

                }


                openTimeWheel( id );

              }
            );

        }
      );

  }


  /*
    The wheel: quarter hours only, as asked.
    Built here rather than taken from the
    browser so a phone gets the same list the
    desktop does while the digits stay
    typeable on both.
  */

  function openTimeWheel(
    id
  ) {

    closeTimeWheel();


    const control =
      document
        .querySelector(
          `[data-time-control="${id}"]`
        );


    if ( !control ) {

      return;

    }


    const list =
      document
        .createElement( 'div' );


    list.className = 'time-wheel';


    list
      .setAttribute(
        'role',
        'listbox'
      );


    const current =
      readTimeControl( id );


    let selected = null;


    for (
      let minutes = 0;
      minutes < 24 * 60;
      minutes += QUARTER_MINUTES
    ) {

      const hour24 =
        Math.floor( minutes / 60 );


      const minute =
        minutes % 60;


      const value =
        String( hour24 )
          .padStart( 2, '0' ) +
        ':' +
        String( minute )
          .padStart( 2, '0' );


      const option =
        document
          .createElement( 'button' );


      option.type = 'button';

      option.className =
        'time-wheel-option';

      option.dataset.value = value;

      option.textContent =
        formatClockLabel(
          hour24,
          minute
        );


      if ( value === current ) {

        option.classList
          .add( 'is-current' );

        selected = option;

      }


      option
        .addEventListener(
          'click',
          (clickEvent) => {

            clickEvent.preventDefault();

            clickEvent.stopPropagation();


            writeTimeControl(
              id,
              value
            );


            $(id + 'Time')
              .dispatchEvent(
                new Event(
                  'input',
                  {
                    bubbles:
                      true
                  }
                )
              );


            closeTimeWheel();

          }
        );


      list.appendChild( option );

    }


    control.appendChild( list );


    /*
      Open on the current value so the wheel
      starts where the field already is.
    */

    if ( selected ) {

      list.scrollTop =
        selected.offsetTop -
        list.clientHeight / 2 +
        selected.offsetHeight / 2;

    } else {

      /*
        No value yet: start the list at a
        plausible teaching hour rather than
        midnight.
      */

      list.scrollTop =
        ( 15 * 60 / QUARTER_MINUTES ) *
        32 -
        list.clientHeight / 2;

    }


    state.openTimeWheel = id;

  }


  function closeTimeWheel() {

    document
      .querySelectorAll(
        '.time-wheel'
      )
      .forEach(
        (node) => {

          node.remove();

        }
      );


    state.openTimeWheel = null;

  }


    function formatClockLabel(
    hour24,
    minute
  ) {

    if ( is24h() ) {

      return (
        String( hour24 ).padStart( 2, '0' ) +
        ':' +
        String( minute ).padStart( 2, '0' )
      );

    }


    if ( localizedClock() ) {

      const text =
        intlTime( hour24 * 60 + minute, true );

      if ( text ) {

        return text;

      }

    }


    const hour =
      hour24 % 12 === 0
        ? 12
        : hour24 % 12;



    return (
      hour +
      ':' +
      String( minute )
        .padStart( 2, '0' ) +
      ' ' +
      ( hour24 >= 12
        ? 'PM'
        : 'AM' )
    );

  }




  function openRequestModal() {

    /*
      Default to the next quarter-hour mark
      the schedule is advertised from, so the
      form opens on a time that could
      actually be requested.
    */

    const start =
      roundUpToQuarterMinuteKey(
        getPortalNowMinuteKey()
      );


    $('requestName')
      .value =
        '';


    $('requestSubject')
      .value =
        '';


    $('requestFormat')
      .value =
        '';


    setDateTimeValue(
      'requestStart',
      minuteKeyToLocalDateTime(
        start
      )
    );


    setDateTimeValue(
      'requestEnd',
      minuteKeyToLocalDateTime(
        start +
        60
      )
    );


    $('requestError')
      .textContent =
        '';


    resetRecurrenceControls(
      $('requestModal')
    );


    clearRequestWarning();


    openModal(
      'requestModal'
    );

  }



  function roundUpToQuarterMinuteKey(
    minuteKey
  ) {

    return Math.ceil(
      minuteKey /
      15
    ) *
    15;

  }



  function clearRequestWarning() {

    $('requestWarning')
      .classList
      .add(
        'hidden'
      );


    $('requestWarningSummary')
      .textContent =
        '';


    $('requestWarningList')
      .innerHTML =
        '';


    $('sendRequestAnywayBtn')
      .classList
      .add(
        'hidden'
      );


    $('sendRequestBtn')
      .classList
      .remove(
        'hidden'
      );

  }



  /*
    The public payload already describes a
    day the way a visitor sees it: merged
    availability and anonymised blocked
    sessions. Checking against it needs no
    new endpoint, and the answer always
    matches what the calendar shows.
  */

  async function getScheduleForDate(
    date
  ) {

    if (
      state.scheduleByDate
        .has(
          date
        )
    ) {

      return state.scheduleByDate
        .get(
          date
        );

    }


    const data =
      await api(
        '/events?start=' +
        encodeURIComponent(
          date
        ) +
        '&end=' +
        encodeURIComponent(
          date
        )
      );


    const events =
      data.events ||
      [];


    state.scheduleByDate
      .set(
        date,
        events
      );


    return events;

  }



  async function checkRequestedTime() {

    const startValue =
      $('requestStart')
        .value;


    const endValue =
      $('requestEnd')
        .value;


    const startKey =
      localDateTimeToMinuteKey(
        startValue
      );


    const endKey =
      localDateTimeToMinuteKey(
        endValue
      );


    if (
      startKey ===
        null ||
      endKey ===
        null ||
      endKey <=
        startKey
    ) {

      clearRequestWarning();

      return;

    }


    let events;


    try {

      events =
        await getScheduleForDate(
          startValue
            .slice(
              0,
              10
            )
        );

    } catch {

      /*
        A failed lookup should not stop
        someone asking. The tutor reviews
        every request anyway.
      */

      clearRequestWarning();

      return;

    }


    const overlapping =
      events
        .filter(
          (event) =>
            event.type ===
            'BLOCKED'
        )
        .filter(
          (event) =>
            localDateTimeToMinuteKey(
              event.start
            ) <
            endKey &&
            localDateTimeToMinuteKey(
              event.end
            ) >
            startKey
        );


    if (
      overlapping.length
    ) {

      showRequestWarning(
        t( 'schedule_conflict' ),

        overlapping.length ===
        1
          ? t( 'overlaps_one_owner', { owner: ownerName() } )
          : t( 'overlaps_many_owner', { n: overlapping.length, owner: ownerName() } ),

        overlapping.map(
          (event) => ({
            title:
              labelFor( 'BLOCKED' ),

            start:
              event.start,

            end:
              event.end
          })
        )
      );


      return;

    }


    const windows =
      events
        .filter(
          (event) =>
            event.type ===
            'AVAILABLE'
        );


    const covered =
      windows.some(
        (event) =>
          localDateTimeToMinuteKey(
            event.start
          ) <=
          startKey &&
          localDateTimeToMinuteKey(
            event.end
          ) >=
          endKey
      );


    if (
      !covered
    ) {

      showRequestWarning(
        t( 'outside_hours' ),

        windows.length
          ? ownerName() + ' has not marked that whole time as available.'
          : ownerName() + ' has no availability listed on that day.',

        windows.map(
          (event) => ({
            title:
              labelFor( 'AVAILABLE' ),

            start:
              event.start,

            end:
              event.end
          })
        )
      );


      return;

    }


    clearRequestWarning();

  }



  function showRequestWarning(
    title,
    summary,
    items
  ) {

    $('requestWarningTitle')
      .textContent =
        title;


    $('requestWarningSummary')
      .textContent =
        summary;


    const list =
      $('requestWarningList');


    list.innerHTML =
      '';


    for (
      const item of
      items.slice(
        0,
        6
      )
    ) {

      const row =
        document.createElement(
          'div'
        );


      row.className =
        'conflict-item';


      const label =
        document.createElement(
          'div'
        );


      label.className =
        'conflict-item-title';


      label.textContent =
        item.title;


      const time =
        document.createElement(
          'div'
        );


      time.className =
        'conflict-item-time';


      time.textContent =
        formatBlockedEventRange(
          item.start,
          item.end
        );


      row.append(
        label,
        time
      );


      list.appendChild(
        row
      );

    }


    $('requestWarning')
      .classList
      .remove(
        'hidden'
      );


    $('sendRequestAnywayBtn')
      .classList
      .remove(
        'hidden'
      );


    $('sendRequestBtn')
      .classList
      .add(
        'hidden'
      );

  }



  async function sendRequest(
    force
  ) {

    $('requestError')
      .textContent =
        '';


    const name =
      $('requestName')
        .value
        .trim();


    if (
      !name
    ) {

      $('requestError')
        .textContent =
          t( 'need_name' );


      $('requestName')
        .focus();


      return;

    }


    const email =
      $('requestEmail')
        .value
        .trim();
    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( email )
    ) {
      $('requestError')
        .textContent =
          t( 'need_email', { owner: ownerName() } );
      $('requestEmail')
        .focus();
      return;
    }
    const phone =
      $('requestPhone')
        .value
        .trim();
    const guardian =
      $('requestGuardian')
        .value
        .trim();
    const subject =
      $('requestSubject')
        .value
        .trim();
    if (
      !subject
    ) {
      $('requestError')
        .textContent =
          t( 'need_subject' );
      $('requestSubject')
        .focus();
      return;
    }


    const format =
      $('requestFormat')
        .value;


    if (
      !format
    ) {

      $('requestError')
        .textContent =
          t( 'need_format' );


      $('requestFormat')
        .focus();


      return;

    }


    const start =
      $('requestStart')
        .value;


    const end =
      $('requestEnd')
        .value;


    const startKey =
      localDateTimeToMinuteKey(
        start
      );


    const endKey =
      localDateTimeToMinuteKey(
        end
      );


    if (
      startKey ===
        null ||
      endKey ===
        null
    ) {

      $('requestError')
        .textContent =
          t( 'need_times' );


      return;

    }


    if (
      endKey <=
      startKey
    ) {

      $('requestError')
        .textContent =
          t( 'end_after_start' );


      return;

    }


    let recurrence;


    try {

      recurrence =
        getRecurrenceFromForm(
          $('requestModal')
        );

    } catch (error) {

      $('requestError')
        .textContent =
          error.message;


      return;

    }


    /*
      The warning is raised here rather than
      when the form opens, so it describes a
      time the visitor actually chose. Send
      Anyway is what gets past it.
    */

    if (
      !force
    ) {

      await checkRequestedTime();


      if (
        !$('requestWarning')
          .classList
          .contains(
            'hidden'
          )
      ) {

        return;

      }

    }


    $('sendRequestBtn')
      .disabled =
        true;


    $('sendRequestAnywayBtn')
      .disabled =
        true;


    try {

      await api(
        '/requests',
        {
          method:
            'POST',

          body:
            JSON.stringify({
              name,
              email,
              phone,
              guardian,
              subject,
              format,
              recurrence,
              start,
              end
            })
        }
      );


      closeModal(
        'requestModal'
      );


      setStatus(
        t( 'request_sent', { owner: ownerName() } )
      );

    } catch (error) {

      $('requestError')
        .textContent =
          error.message;

    } finally {

      $('sendRequestBtn')
        .disabled =
          false;


      $('sendRequestAnywayBtn')
        .disabled =
          false;

    }

  }



  /* =========================================================
     SESSION REQUEST REVIEW (ADMIN)
  ========================================================= */


  /*
    A request is only removed once the event
    it became has actually been saved, so a
    cancelled review leaves it in the queue.
  */

  async function clearAcceptedRequest() {

    const id =
      state.acceptedRequestId;


    if (
      !id
    ) {

      return;

    }


    state.acceptedRequestId =
      null;


    try {

      await api(
        '/requests/' +
        encodeURIComponent(
          id
        ),
        {
          method:
            'DELETE'
        }
      );

    } catch {

      /*
        The event saved, which is the part
        that matters. A stale queue entry can
        be dismissed by hand.
      */

    }


    await refreshRequestCount();

  }


  async function refreshRequestCount() {

    if (
      !state.isAdmin
    ) {

      return;

    }


    try {

      const data =
        await api(
          '/requests'
        );


      const total =
        (
          data.requests ||
          []
        ).length;


      $('requestCount')
        .textContent =
          total;

    } catch {

      /*
        The badge is a convenience. A failed
        count should not interrupt admin work.
      */

    }

  }



  async function openRequestDrawer() {

    if (
      !state.isAdmin
    ) {

      return;

    }


    $('requestDrawerBackdrop')
      .classList
      .remove(
        'hidden'
      );


    $('requestListStatus')
      .textContent =
        t( 'loading_requests' );


    $('requestList')
      .innerHTML =
        '';


    try {

      const data =
        await api(
          '/requests'
        );


      renderRequestList(
        data.requests ||
        []
      );

    } catch (error) {

      $('requestListStatus')
        .textContent =
          error.message;

    }

  }



  function closeRequestDrawer() {

    $('requestDrawerBackdrop')
      .classList
      .add(
        'hidden'
      );

  }



  function renderRequestList(
    requests
  ) {

    $('requestCount')
      .textContent =
        requests.length;


    $('requestListStatus')
      .textContent =
        requests.length
          ? t( 'requests_hint' )
          : '';


    const list =
      $('requestList');


    list.innerHTML =
      '';


    if (
      !requests.length
    ) {

      const empty =
        document.createElement(
          'div'
        );


      empty.className =
        'blocked-empty';


      empty.textContent =
        t( 'no_pending_requests' );


      list.appendChild(
        empty
      );


      return;

    }


    for (
      const request of requests
    ) {

      const item =
        document.createElement(
          'div'
        );


      item.className =
        'blocked-session-item request-item';


      const title =
        document.createElement(
          'div'
        );


      title.className =
        'blocked-session-title';


      title.textContent =
        request.name;


      const time =
        document.createElement(
          'div'
        );


      time.className =
        'blocked-session-time';


      time.textContent =
        formatBlockedEventRange(
          request.start,
          request.end
        );


      const meta =
        document.createElement(
          'div'
        );


      meta.className =
        'blocked-session-meta';


      meta.textContent =
        describeRequest(
          request
        );
      const contact =
        renderRequestContact(
          request
        );


      const actions =
        document.createElement(
          'div'
        );


      actions.className =
        'request-item-actions';


      const accept =
        document.createElement(
          'button'
        );


      accept.className =
        'btn primary small';


      accept.textContent =
        t( 'accept' );


      accept.addEventListener(
        'click',
        () =>
          acceptRequest(
            request
          )
      );


      const dismiss =
        document.createElement(
          'button'
        );


      dismiss.className =
        'btn danger small';


      dismiss.textContent =
        t( 'dismiss' );


      dismiss.addEventListener(
        'click',
        () =>
          dismissRequest(
            request
          )
      );


      actions.append(
        accept,
        dismiss
      );


      item.append(
        title,
        time,
        meta,
        contact,
        actions
      );
      list.appendChild(
        item
      );

    }

  }



  function formatLabel(
    request
  ) {

    return request.format ===
      'ONLINE'
      ? 'Online'
      : 'In-Person';

  }



  /*
    The calendar card shows the title, so the
    title carries who this is and how it is
    run. The subject is detail behind that,
    which is what notes are for.
  */

  function buildSessionTitle(
    request
  ) {

    return [
      request.name,
      '(' + formatLabel( request ) + ')'
    ]
      .join( ' ' );

  }



  /*
    Requests made before the form offered
    full weekly options carry a plain repeat
    flag instead of a recurrence, so both
    shapes are read here.
  */

  function requestRecurrence(
    request
  ) {

    if (
      request.recurrence
    ) {

      return request.recurrence;

    }


    if (
      request.repeat !==
      'WEEKLY'
    ) {

      return null;

    }


    return {
      frequency:
        'WEEKLY',

      interval:
        1,

      weekdays: [
        new Date(
          request.start
        )
          .getDay()
      ],

      endType:
        'NEVER'
    };

  }



  function describeRepeat(
    request
  ) {

    const recurrence =
      requestRecurrence(
        request
      );


    if (
      !recurrence
    ) {

      return t( 'one_time' );

    }


    const every =
      recurrence.interval >
      1
        ? t( 'every_n_weeks', { n: recurrence.interval } )
                : t( 'weekly' );


    if (
      recurrence.endType ===
      'ON'
    ) {

      return `${every} until ${recurrence.until}`;

    }


    if (
      recurrence.endType ===
      'COUNT'
    ) {

      return `${every}, ${recurrence.count} times`;

    }


    return every;

  }



  /*
    How to reach the requester: email and phone as links that open
    the mail app or dialler, the guardian's name beside them. Seen
    only in the admin's list.
  */
  function renderRequestContact(
    request
  ) {
    const line =
      document.createElement( 'div' );
    line.className =
      'request-contact';
    if ( request.guardian ) {
      const who =
        document.createElement( 'span' );
      who.textContent =
        t( 'guardian_label' ) + request.guardian;
      line.appendChild( who );
    }
    if ( request.email ) {
      const mail =
        document.createElement( 'a' );
      mail.href =
        'mailto:' + request.email;
      mail.textContent =
        request.email;
      line.appendChild( mail );
    }
    if ( request.phone ) {
      const tel =
        document.createElement( 'a' );
      tel.href =
        'tel:' + request.phone.replace( /[^0-9+]/g, '' );
      tel.textContent =
        request.phone;
      line.appendChild( tel );
    }
    if ( !line.childNodes.length ) {
      line.textContent =
        t( 'no_contact' );
    }
    return line;
  }

  function describeRequest(
    request
  ) {

    return [
      request.subject,

      formatLabel(
        request
      ),

      describeRepeat(
        request
      )
    ]
      .join(' · ');

  }



  /*
    Accepting does not save anything. It
    opens the editor with the request
    translated into an event so the tutor
    reviews it, and the request is only
    cleared once that event is saved.
  */

  function acceptRequest(
    request
  ) {

    closeRequestDrawer();


    openEventModal({
      type:
        'BLOCKED',
      title:
        buildSessionTitle(
          request
        ),
      notes:
        [
          request.subject,
          request.guardian
            ? t( 'guardian_label' ) + request.guardian
            : '',
          request.email || '',
          request.phone || ''
        ]
          .filter( Boolean )
          .join( '\n' ),

      start:
        request.start,

      end:
        request.end,

      recurrence:
        requestRecurrence(
          request
        )

    });


    state.acceptedRequestId =
      request.id;

  }



  async function dismissRequest(
    request
  ) {

    try {

      await api(
        '/requests/' +
        encodeURIComponent(
          request.id
        ),
        {
          method:
            'DELETE'
        }
      );


      await openRequestDrawer();

    } catch (error) {

      $('requestListStatus')
        .textContent =
          error.message;

    }

  }



  function openAdminLogin() {

    $('loginError')
      .textContent =
        '';


    $('adminPasswordInput')
      .value =
        '';
    $('loginEmailInput')
      .value =
        '';
    $('loginPasswordInput')
      .value =
        '';


    /*
      An account signs in with its email. The first calendar, until
      an account claims it, still opens with the site's admin
      password, so the dialog offers that way too.
    */
    const legacyPossible =
      Boolean( state.calendar && !state.calendar.claimed );
    $('legacyLoginLink')
      .classList
      .toggle( 'hidden', !legacyPossible );
    setLoginMode( legacyPossible ? 'legacy' : 'account' );


    openModal(
      'loginModal'
    );


    setTimeout(
      () => {

        $( legacyPossible ? 'adminPasswordInput' : 'loginEmailInput' )
          .focus();

      },
      50
    );

  }


  function setLoginMode(
    mode
  ) {
    state.loginMode =
      mode;
    const legacy =
      mode === 'legacy';
    $('accountLoginFields')
      .classList
      .toggle( 'hidden', legacy );
    $('legacyLoginFields')
      .classList
      .toggle( 'hidden', !legacy );
    $('loginTitle')
      .textContent =
        legacy ? t( 'admin_access' ) : t( 'login_title' );
    $('loginSubmitBtn')
      .textContent =
        legacy ? t( 'enter_admin' ) : t( 'login_btn' );
    $('legacyLoginLink')
      .textContent =
        legacy ? t( 'login_with_account' ) : t( 'use_admin_password' );
    $('loginError')
      .textContent =
        '';
  }



  async function submitAdminLogin() {

    if ( state.loginMode !== 'legacy' ) {

      return submitAccountLogin();

    }


    const password =
      $('adminPasswordInput')
        .value;


    $('loginError')
      .textContent =
        '';


    $('loginSubmitBtn')
      .disabled =
        true;


    try {

      state.adminPassword =
        password;


      state.isAdmin =
        true;


      const remember =
        $('rememberMeInput')
          .checked;


      const result =
        await api(
          '/login',
          {
            method:
              'POST',

            body:
              JSON.stringify({
                remember
              })
          }
        );


      /*
        The device keeps a token, never the password. Sending the
        token from here on (and not the password) is what lets a
        reload come back signed in.
      */

      if (
        remember &&
        result.token
      ) {

        rememberDevice(
          result.token,
          result.expiresAt
        );

      } else {

        forgetDevice();

      }


      closeModal(
        'loginModal'
      );


      await loadWeek();

    } catch (error) {

      state.adminPassword =
        '';


      state.isAdmin =
        false;


      $('loginError')
        .textContent =
          error.message;

    } finally {

      $('loginSubmitBtn')
        .disabled =
          false;

    }

  }



  /*
    Sign in with an account. The session comes back with the account,
    including the address of its calendar: this one, or another.
  */

  async function submitAccountLogin() {

    const email =
      $('loginEmailInput').value.trim();
    const password =
      $('loginPasswordInput').value;
    const remember =
      $('rememberMeInput').checked;

    $('loginError').textContent = '';
    if ( !email || !password ) {
      $('loginError').textContent =
        t( 'login_blank' );
      return;
    }
    $('loginSubmitBtn').disabled = true;

    try {

      const result =
        await fetch(
          '/api/login',
          {
            method:
              'POST',
            headers:
              { 'Content-Type': 'application/json' },
            body:
              JSON.stringify({ email, password }),
            cache:
              'no-store'
          }
        );
      const data =
        await result.json().catch( () => ({}) );
      if ( !result.ok ) {
        throw new Error( data.error || `Request failed (${ result.status })` );
      }

      state.session =
        { token: data.token, expiresAt: data.expiresAt, slug: data.account.slug };
      state.account =
        data.account;
      window.CalendarSession.save( state.session, remember );
      forgetDevice();

      closeModal( 'loginModal' );

      /*
        The account's own calendar opens in admin mode; any other
        stays as it was, with the chip now offering the way home.
      */
      const here =
        state.calendar ? state.calendar.slug : null;
      state.isAdmin =
        here === data.account.slug;
      await loadWeek();

    } catch (error) {

      $('loginError').textContent =
        error.message;

    } finally {

      $('loginSubmitBtn').disabled = false;

    }

  }


  /*
    CHANGE PASSWORD

    The account's own password: the current one proves it is the
    owner asking, and the change signs every other device out - the
    server hands this one a fresh session.
  */
  function openChangePassword() {
    [ 'currentPasswordInput', 'newPasswordInput', 'newPasswordAgainInput' ]
      .forEach( (id) => { $(id).value = ''; } );
    $('passwordError').textContent = '';
    openModal( 'passwordModal' );
    setTimeout( () => { $('currentPasswordInput').focus(); }, 50 );
  }


  async function savePassword() {
    const current =
      $('currentPasswordInput').value;
    const next =
      $('newPasswordInput').value;
    const again =
      $('newPasswordAgainInput').value;
    $('passwordError').textContent = '';
    if ( next.length < 8 ) {
      $('passwordError').textContent =
        t( 'auth_need_pw' );
      return;
    }
    if ( next !== again ) {
      $('passwordError').textContent =
        t( 'cp_mismatch' );
      return;
    }
    $('savePasswordBtn').disabled = true;
    try {
      const data =
        await api(
          '/account/password',
          {
            method:
              'POST',
            body:
              JSON.stringify({ current, password: next })
          }
        );
      let remembered =
        true;
      try {
        remembered =
          Boolean( localStorage.getItem( 'calendarSession' ) );
      } catch {
        remembered =
          true;
      }
      state.session =
        { token: data.token, expiresAt: data.expiresAt, slug: data.account.slug };
      window.CalendarSession.save( state.session, remembered );
      closeModal( 'passwordModal' );
      setStatus( t( 'cp_done' ) );
    } catch (error) {
      $('passwordError').textContent =
        error.message;
    } finally {
      $('savePasswordBtn').disabled = false;
    }
  }


  /*
    The name a booked session gets on the owner's Google calendar is
    asked for only where it applies: a booked session, on a calendar
    that mirrors to Google. Blank means the mirror's plain "Blocked".
  */
  function syncGoogleTitleField() {
    $('googleTitleField')
      .classList
      .toggle(
        'hidden',
        !(
          state.config.googleSync &&
          $('eventType').value === 'BLOCKED'
        )
      );
  }


  /*
    The category is offered only for a booked session, and only once
    the owner has named some in Settings - or when the session is
    already omitted, so it can be counted again.
  */
  function syncCategoryField() {
    $('categoryField')
      .classList
      .toggle(
        'hidden',
        !(
          (
            state.categories.length ||
            $('eventCategory').value === OMITTED
          ) &&
          $('eventType').value === 'BLOCKED'
        )
      );
  }


  function fillCategorySelect(
    chosen
  ) {
    const select =
      $('eventCategory');
    select.innerHTML = '';
    const none =
      document.createElement( 'option' );
    none.value = '';
    none.textContent =
      t( 'e_category_none' );
    select.appendChild( none );
    state.categories.forEach(
      (category) => {
        const option =
          document.createElement( 'option' );
        option.value =
          category.id;
        option.textContent =
          category.name;
        select.appendChild( option );
      }
    );
    const omitted =
      document.createElement( 'option' );
    omitted.value =
      OMITTED;
    omitted.textContent =
      t( 'e_category_omitted' );
    select.appendChild( omitted );
    select.value =
      chosen === OMITTED ||
      state.categories.some( (category) => category.id === chosen )
        ? chosen
        : '';
  }


  function categoryName(
    id
  ) {
    const found =
      state.categories.find(
        (category) =>
          category.id === id
      );
    return found
      ? found.name
      : '';
  }


  /*
    The list of categories being edited in Settings: a name box and
    a Remove for each, and a way to add one. Ids stay with their
    rows, so renaming keeps the sessions filed under them.
  */
  function renderCategoryList() {
    const list =
      $('categoryList');
    list.innerHTML = '';
    ( state.settingsCategories || [] ).forEach(
      (category, index) => {
        const row =
          document.createElement( 'div' );
        row.className =
          'category-row';
        const input =
          document.createElement( 'input' );
        input.type = 'text';
        input.maxLength = 30;
        input.value =
          category.name;
        input.placeholder =
          t( 's_category_name' );
        input.setAttribute( 'aria-label', t( 's_category_name' ) );
        input.addEventListener(
          'input',
          () => {
            category.name =
              input.value;
          }
        );
        const remove =
          document.createElement( 'button' );
        remove.type = 'button';
        remove.className =
          'text-btn';
        remove.textContent =
          t( 's_category_remove' );
        remove.addEventListener(
          'click',
          () => {
            state.settingsCategories.splice( index, 1 );
            renderCategoryList();
          }
        );
        row.append( input, remove );
        list.appendChild( row );
      }
    );
  }


  function addCategoryRow() {
    state.settingsCategories =
      state.settingsCategories || [];
    if ( state.settingsCategories.length >= 12 ) {
      return;
    }
    state.settingsCategories.push({
      id: '',
      name: ''
    });
    renderCategoryList();
    const inputs =
      $('categoryList').querySelectorAll( 'input' );
    if ( inputs.length ) {
      inputs[ inputs.length - 1 ].focus();
    }
  }


  /*
    What the account is: the site's owner is the Admin, any other
    account the Owner of its calendars, and the site's admin password
    (before an account claimed the first calendar) counts as Admin.
  */
  function roleName() {
    if ( state.account ) {
      return t( state.account.master ? 'role_admin' : 'role_owner' );
    }
    return t( 'role_admin' );
  }


  function ownsThisCalendar() {
    if ( !state.session || !state.account || !state.calendar ) {
      return false;
    }
    if ( typeof state.calendar.owned === 'boolean' ) {
      return state.calendar.owned;
    }
    return state.account.slug === state.calendar.slug;
  }


  /* =========================================================
     SEVERAL CALENDARS IN ONE VIEW
  ========================================================= */

  /*
    An account may own more than one calendar. On any of them, the
    owner can draw the others over it: their blocks appear in their
    own colors with the calendar's name on them, and can be edited in
    place - the page remembers which calendar each borrowed block
    belongs to and sends the write there. The choice of which to show
    is kept on the device, per calendar.
  */

  function overlaysKey() {
    return 'overlays:' + ( state.calendarSlug || 'main' );
  }


  function shownOverlays() {
    try {
      const saved =
        JSON.parse( localStorage.getItem( overlaysKey() ) || '[]' );
      return Array.isArray( saved ) ? saved.filter( (slug) => typeof slug === 'string' ) : [];
    } catch {
      return [];
    }
  }


  function saveShownOverlays(
    slugs
  ) {
    try {
      localStorage.setItem( overlaysKey(), JSON.stringify( slugs ) );
    } catch {
      /* storage off: the choice lasts for this page only */
    }
  }


  /*
    Borrowed events join the week's list with their calendar's colors
    already applied and a note of where they came from.
  */
  function mergeOverlays(
    overlays
  ) {
    state.overlays =
      overlays;
    state.overlayOwner =
      {};
    Object.entries( overlays ).forEach(
      ([ slug, calendar ]) => {
        ( calendar.events || [] ).forEach(
          (event) => {
            const type =
              event.type === 'AVAILABLE' ? 'available' : 'blocked';
            state.events.push({
              ...event,
              color:
                normalizeHex( event.color ) || normalizeHex( calendar.colors && calendar.colors[ type ] ) || null,
              overlay:
                slug,
              overlayTitle:
                calendar.title
            });
            state.overlayOwner[ event.id ] =
              slug;
            if ( event.masterId ) {
              state.overlayOwner[ event.masterId ] =
                slug;
            }
          }
        );
      }
    );
  }


  /*
    Which calendar a request is really about: the one that owns the
    event in its path or body, if that event was borrowed.
  */
  function overlayCalendarFor(
    path,
    method,
    body
  ) {
    const inPath =
      /^\/events\/([^/?]+)/.exec( path );
    let id =
      inPath ? decodeURIComponent( inPath[ 1 ] ) : null;
    if ( !id && path.split( '?' )[ 0 ] === '/events' && method === 'POST' && body ) {
      try {
        id =
          JSON.parse( body ).id || null;
      } catch {
        id =
          null;
      }
    }
    return id ? state.overlayOwner[ id ] || null : null;
  }


  /*
    The account's calendars, fetched once per sign-in for the menu.
  */
  async function loadMyCalendars() {
    if ( !state.session || state.myCalendars.length ) {
      return;
    }
    try {
      const data =
        await api( '/me' );
      state.myCalendars =
        data.calendars || [];
      state.account =
        data.account || state.account;
    } catch {
      state.myCalendars =
        [];
    }
    renderCalendarsMenu();
  }


  function renderCalendarsMenu() {
    const others =
      state.myCalendars.filter(
        (calendar) => state.calendar && calendar.slug !== state.calendar.slug
      );
    const here =
      state.myCalendars.find(
        (calendar) => state.calendar && calendar.slug === state.calendar.slug
      );
    /*
      The switch is worth showing once there is more than one calendar
      to choose from - or always to the master, who may borrow any.
    */
    const show =
      state.isAdmin &&
      state.session &&
      ( others.length > 0 || ( state.account && state.account.master ) );
    $('calendarsPanel')
      .classList
      .toggle( 'hidden', !show );
    $('calendarsBtn')
      .classList
      .toggle( 'hidden', !show );
    document.querySelector( '.calendar-body' )
      .classList
      .toggle( 'with-panel', show );
    if ( !show ) {
      return;
    }
    const list =
      $('calendarsList');
    list.innerHTML =
      '';
    const shown =
      shownOverlays();
    const rows =
      [ ...( here ? [ here ] : [] ), ...others ];
    rows.forEach(
      (calendar) => {
        const row =
          document.createElement( 'label' );
        row.className =
          'calendar-row';
        const box =
          document.createElement( 'input' );
        box.type =
          'checkbox';
        box.setAttribute( 'role', 'switch' );
        const isHere =
          here && calendar.slug === here.slug;
        box.checked =
          isHere || shown.includes( calendar.slug );
        box.disabled =
          Boolean( isHere );
        box.setAttribute( 'aria-checked', box.checked ? 'true' : 'false' );
        box.addEventListener(
          'change',
          () => {
            const next =
              shownOverlays().filter( (slug) => slug !== calendar.slug );
            if ( box.checked ) {
              next.push( calendar.slug );
            }
            saveShownOverlays( next );
            loadWeek( true );
          }
        );
        const dot =
          document.createElement( 'span' );
        dot.className =
          'calendar-dot';
        dot.style.background =
          ( calendar.colors && calendar.colors.blocked ) || '#b42318';
        const name =
          document.createElement( 'span' );
        name.className =
          'calendar-name';
        name.textContent =
          calendar.title;
        row.append( box, dot, name );
        if ( !isHere ) {
          const open =
            document.createElement( 'a' );
          open.href =
            '/' + calendar.slug;
          open.textContent =
            t( 'open' );
          row.appendChild( open );
        }
        list.appendChild( row );
      }
    );
  }


  function toggleToolsMenu() {
    const open =
      $('toolsMenu').classList.contains( 'hidden' );
    $('toolsMenu').classList.toggle( 'hidden', !open );
    $('gearBtn').setAttribute( 'aria-expanded', open ? 'true' : 'false' );
  }


  function closeToolsMenu() {
    $('toolsMenu').classList.add( 'hidden' );
    $('gearBtn').setAttribute( 'aria-expanded', 'false' );
  }


  function forgetSession() {
    state.session =
      null;
    state.account =
      null;
    state.myCalendars =
      [];
    state.preview =
      false;
    window.CalendarSession.clear();
  }


  /*
    Added to a home screen, the app should open on this calendar, not
    the home page: the manifest is written for the address in hand.
  */
  function installManifest() {
    if ( !state.calendarSlug ) {
      return;
    }
    const link =
      document.querySelector( 'link[rel="manifest"]' );
    if ( !link ) {
      return;
    }
    const manifest = {
      name:
        'MyOpenings',
      short_name:
        'MyOpenings',
      start_url:
        '/' + state.calendarSlug,
      scope:
        '/',
      display:
        'standalone',
      background_color:
        '#f6f7fb',
      theme_color:
        '#ffffff',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    };
    link.href =
      'data:application/manifest+json,' +
      encodeURIComponent( JSON.stringify( manifest ) );
  }


  /*
    LANGUAGE

    The device's choice, else the browser's language, else the
    calendar's default once the settings arrive. Changing it redraws
    everything a visitor reads without a reload.
  */
  function initLanguage() {
    const select =
      $('langSelect');
    Object.entries( window.I18N.LANGUAGES ).forEach(
      ([ code, name ]) => {
        const option =
          document.createElement( 'option' );
        option.value =
          code;
        option.textContent =
          name;
        select.appendChild( option );
      }
    );
    select.addEventListener(
      'change',
      () => {
        window.I18N.set( select.value );
        applyLanguage();
        renderAll();
        loadWeek( true );
      }
    );
    window.I18N.set( window.I18N.detect( 'en' ), false );
    applyLanguage();
  }


  /*
    The calendar's own default applies when this device never chose
    and the browser's language is not one we have.
  */
  function syncLanguage() {
    const wanted =
      window.I18N.detect( state.config.language || 'en' );
    if ( wanted !== window.I18N.get() ) {
      window.I18N.set( wanted, false );
      applyLanguage();
    }
  }


  function applyLanguage() {
    window.I18N.apply();
    $('langSelect').value =
      window.I18N.get();
    $('langSelect').title =
      t( 'language' );
    if ( state.loginMode ) {
      setLoginMode( state.loginMode );
    }
    if ( state.view && $('saveWeekBtn') ) {
      applyView();
    }
  }


  /*
    The address in the page's own URL: /ethan names the calendar
    "ethan"; the page itself, or no path, means the first calendar.
  */
  function slugFromLocation() {
    const path =
      window.location.pathname
        .replace( /^\/+|\/+$/g, '' )
        .toLowerCase();
    if (
      !path ||
      path === 'index.html' ||
      path === 'calendar.html'
    ) {
      return '';
    }
    return path;
  }


  /*
    No calendar at this address, or one that is not published yet:
    the page says so in place of the grid.
  */
  function showMissingCalendar(
    reason
  ) {
    document.body.classList.add( 'calendar-missing' );
    $('missingTitle').textContent =
      t( reason.unpublished ? 'unpublished_title' : 'missing_title' );
    $('missingText').textContent =
      t( reason.unpublished ? 'unpublished_text' : 'missing_text' );
    $('portalTitle').textContent =
      'MyOpenings';
    document.title =
      'MyOpenings';
    $('updatedLabel').textContent =
      '';
    setStatus( '' );
  }


  /*
    The owner has not confirmed their email yet: the calendar is not
    public until they do, and the banner says so.
  */
  function renderVerifyNotice() {
    const show =
      state.isAdmin &&
      state.account &&
      !state.account.verified &&
      ownsThisCalendar() &&
      state.calendar &&
      state.calendar.claimed;
    $('verifyNotice')
      .classList
      .toggle( 'hidden', !show );
    if ( show ) {
      $('verifyNoticeText').textContent =
        state.calendar.live
          ? `Confirm your email (${ state.account.email }) so you can reset your password if you ever forget it.`
          : `Confirm your email (${ state.account.email }) to publish this calendar. Until then only you can see it.`;
    }
  }


  async function resendVerification() {
    $('resendVerifyBtn').disabled = true;
    try {
      const data =
        await api( '/resend', { method: 'POST' } );
      setStatus(
        data.verification === 'sent'
          ? t( 'confirm_sent' )
          : data.verification === 'done'
            ? t( 'already_confirmed' )
            : t( 'email_not_sent' )
      );
    } catch (error) {
      setStatus( error.message );
    } finally {
      $('resendVerifyBtn').disabled = false;
    }
  }


  /*
    Public view steps out of admin mode for this page but keeps the
    device signed in, so Admin comes straight back without asking.
    Sign out forgets the device.
  */

  function exitAdmin() {

    closeBlockedSessions();


    state.isAdmin =
      false;


    state.adminPassword =
      '';


    /*
      Signed in with an account, the page keeps its session and asks
      the server for what a visitor would get instead.
    */
    state.preview =
      Boolean( state.session );


    return loadWeek();

  }


  async function signOut() {

    forgetDevice();
    forgetSession();


    await exitAdmin();


    setStatus(
      t( 'signed_out' )
    );

  }


  /* =========================================================
     SETTINGS (ADMIN)
  ========================================================= */

  /*
    The calendar's own settings - title, name, time zone, hours, the
    two default colours and the words for open and booked time - come
    with every load as state.config and are applied here: the colours
    become the page's variables, the words replace the built-in ones.
  */

  const BUILT_IN_COLORS = {
    AVAILABLE:
      '#2f7d4a',
    BLOCKED:
      '#b42318'
  };

  /*
    The words for open and booked time and for whoever books it are
    the owner's, typed in Settings. Left at the built-in defaults,
    they read in the visitor's language; changed, they read as typed.
  */
  const DEFAULT_LABELS = {
    available: 'Available',
    blocked: 'Blocked Session',
    person: 'student',
    people: 'students'
  };

  function ownerWord(
    key
  ) {
    const labels =
      state.config.labels || {};
    const word =
      labels[ key ] || DEFAULT_LABELS[ key ];
    return word === DEFAULT_LABELS[ key ]
      ? t( 'label_' + key )
      : word;
  }

  function labelFor(
    type
  ) {
    return ownerWord( type === 'AVAILABLE' ? 'available' : 'blocked' );
  }

  /*
    Whoever owns this calendar, by the display name in the settings:
    the requester is told "Maya will confirm it", not "the tutor".
  */
  function ownerName() {
    return ( state.config.tutorName || '' ).trim() || t( 'the_owner' );
  }

  function peopleWord(
    count
  ) {
    return ownerWord( count === 1 ? 'person' : 'people' );
  }

  function applyConfigStyling() {
    const colors =
      state.config.colors || {};
    const root =
      document.documentElement.style;
    const paint =
      (prefix, hex) => {
        const shades =
          cardShades(
            normalizeHex( hex ) ||
            BUILT_IN_COLORS[ prefix === 'available' ? 'AVAILABLE' : 'BLOCKED' ]
          );
        root.setProperty( '--' + prefix, shades.ink );
        root.setProperty( '--' + prefix + '-bg', shades.tint );
        root.setProperty( '--' + prefix + '-border', shades.border );
      };
        paint( 'available', colors.available );
    paint( 'blocked', colors.blocked );
    const html =
      document.documentElement;
    if ( state.config.font && state.config.font !== 'system' ) {
      html.setAttribute( 'data-font', state.config.font );
    } else {
      html.removeAttribute( 'data-font' );
    }
    html.setAttribute( 'data-clock', is24h() ? '24' : '12' );
    /*
      A new first day of the week moves the week on screen to the one
      that contains the same days.
    */
    if ( state.view === 'week' ) {
      state.weekStart =
        startOfWeek( addDays( state.weekStart, 3 ) );
    }
    const setText =
      (id, text) => {
        const element =
          $(id);
        if ( element ) {
          element.textContent =
            text;
        }
      };
    setText( 'legendAvailable', labelFor( 'AVAILABLE' ) );
    setText( 'legendBlocked', labelFor( 'BLOCKED' ) );
    setText( 'eventTypeAvailableOption', labelFor( 'AVAILABLE' ) );
    setText( 'summaryPeopleLabel', peopleWord( 2 ) );
    setText( 'summaryToggleLabel',
      t( $('summaryList') && !$('summaryList').classList.contains( 'hidden' ) ? 'hide_all' : 'show_all', { noun: peopleWord( 2 ) } ) );
    setText( 'summaryHoursLabel', t( 'hours_blocked_week' ) );
    const requestRules =
      state.config.requests || {};
    setText( 'requestIntro', requestRules.intro || t( 'request_intro', { owner: ownerName() } ) );
    setText( 'requestRules', describeRequestRules( requestRules ) );
    if ( $('requestRules') ) {
      $('requestRules').classList.toggle( 'hidden', !describeRequestRules( requestRules ) );
    }
    setText( 'requestWarningFooter', t( 'warning_footer', { owner: ownerName() } ) );
    setText( 'requestEmailHint', t( 'email_hint', { owner: ownerName() } ) );
    const description =
      document.querySelector( 'meta[name="description"]' );
    if ( description ) {
      description.setAttribute( 'content', state.config.portalTitle || '' );
    }
    setText( 'requestsSubtitle', t( 'submitted_by', { people: peopleWord( 2 ) } ) );
  }

  /*
    The dialog. Hours are whole hours; the time zone list is the
    browser's own where it has one, else a short list plus whatever
    the calendar is set to now.
  */

  const FALLBACK_TIMEZONES = [
    'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
    'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
    'Europe/Berlin', 'Europe/Madrid', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland'
  ];

  function timezoneChoices() {
    try {
      const all =
        Intl.supportedValuesOf( 'timeZone' );
      if ( Array.isArray( all ) && all.length ) {
        return all;
      }
    } catch {}
    return FALLBACK_TIMEZONES;
  }

  function fillHourSelect(
    select,
    from,
    to
  ) {
    select.innerHTML = '';
    for ( let hour = from; hour <= to; hour++ ) {
      const option =
        document.createElement( 'option' );
      option.value =
        String( hour );
      option.textContent =
        hour === 24
          ? ( is24h() ? '24:00 (midnight)' : '12 AM (midnight)' )
          : formatMinutes( hour * 60 );
      select.appendChild( option );
    }
  }

  /*
    Ready-made wording for the kinds of calendar people keep: what open
    and booked time are called, and the word for whoever books it.
  */
  const WORDING_PRESETS = {
    tutoring:     { available: 'Available',  blocked: 'Blocked Session', person: 'student',  people: 'students' },
    lessons:      { available: 'Open',       blocked: 'Lesson',          person: 'pupil',    people: 'pupils' },
    office:       { available: 'Open',       blocked: 'Meeting',         person: 'visitor',  people: 'visitors' },
    coaching:     { available: 'Open',       blocked: 'Session',         person: 'client',   people: 'clients' },
    classes:      { available: 'Open',       blocked: 'Class',           person: 'attendee', people: 'attendees' },
    appointments: { available: 'Open',       blocked: 'Appointment',     person: 'client',   people: 'clients' }
  };

  /*
    Session lengths from a quarter hour to eight hours, in the steps
    people actually use.
  */
  function fillMinuteSelect(
    select,
    chosen
  ) {
    const steps =
      [ 15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480 ];
    if ( !steps.includes( chosen ) ) {
      steps.push( chosen );
      steps.sort( (a, b) => a - b );
    }
    select.innerHTML = '';
    steps.forEach(
      (minutes) => {
        const option =
          document.createElement( 'option' );
        option.value =
          String( minutes );
        option.textContent =
          minutes % 60 === 0
            ? ( minutes / 60 ) + ( minutes === 60 ? ' hour' : ' hours' )
            : minutes > 60
              ? Math.floor( minutes / 60 ) + ' h ' + ( minutes % 60 ) + ' min'
              : minutes + ' minutes';
        select.appendChild( option );
      }
    );
    select.value =
      String( chosen );
  }

  function renderShareLink(
    slug
  ) {
    $('shareLink').textContent =
      window.location.origin + '/' + ( slug || '' );
  }

  async function openSettings() {
    endAction();
    $('settingsError').textContent = '';
    let settings;
    let mail;
    let slug;
    let google;
    let feed;
    try {
      const data =
        await api( '/settings' );
      settings =
        data.settings;
      mail =
        data.mail;
      slug =
        data.slug;
      google =
        data.google || {};
      feed =
        data.feed || {};
    } catch (error) {
      setStatus( error.message );
      return;
    }
    renderMailStatus(
      mail,
      settings.notificationEmail
    );
    $('googleSetup')
      .classList
      .toggle( 'hidden', !google.available );
    $('googleUnavailable')
      .classList
      .toggle( 'hidden', Boolean( google.available ) );
    $('serviceAccountEmail').textContent =
      google.serviceAccountEmail || '';
    $('settingGoogleCalendarId').value =
      google.calendarId || '';
    $('googleFromSite')
      .classList
      .toggle( 'hidden', !google.fromSite );
    $('feedLink').textContent =
      feed.url || '';
    const requests =
      settings.requests || {};
    $('settingRequestsEnabled').checked =
      requests.enabled !== false;
    $('settingRequestIntro').value =
      requests.intro || '';
    $('settingMinNotice').value =
      String( requests.minNoticeHours || 0 );
    $('settingMaxWeeks').value =
      String( requests.maxWeeksAhead || 12 );
    fillMinuteSelect( $('settingMinMinutes'), requests.minMinutes || 15 );
    fillMinuteSelect( $('settingMaxMinutes'), requests.maxMinutes || 480 );
    $('settingShowBooked').checked =
      !settings.privacy || settings.privacy.showBooked !== false;
    state.settingsCategories =
      ( settings.categories || [] ).map(
        (category) => ({ ...category })
      );
    renderCategoryList();
    $('settingWeekStart').value =
      String( settings.weekStart === 1 ? 1 : 0 );
    $('settingHourFormat').value =
      settings.hourFormat === '24' ? '24' : '12';
    $('settingFont').value =
      settings.font || 'system';
    $('settingLanguage').value =
      settings.language || 'en';
    $('settingPreset').value =
      '';
    $('settingSlug').value =
      slug || '';
    $('settingSlugPrefix').textContent =
      window.location.host + '/';
    renderShareLink( slug );
    $('settingTitle').value =
      settings.title || '';
    $('settingDisplayName').value =
      settings.displayName || '';
    const zones =
      timezoneChoices();
    const zoneSelect =
      $('settingTimezone');
    zoneSelect.innerHTML = '';
    const list =
      zones.includes( settings.timezoneId )
        ? zones
        : [ settings.timezoneId, ...zones ];
    list.forEach(
      (zone) => {
        const option =
          document.createElement( 'option' );
        option.value = zone;
        option.textContent =
          zone.replace( /_/g, ' ' );
        zoneSelect.appendChild( option );
      }
    );
    zoneSelect.value =
      settings.timezoneId;
    fillHourSelect( $('settingDayStart'), 0, 23 );
    fillHourSelect( $('settingDayEnd'), 1, 24 );
    $('settingDayStart').value =
      String( settings.dayStart );
    $('settingDayEnd').value =
      String( settings.dayEnd );
    state.settingsColors = {
      available:
        normalizeHex( settings.colors && settings.colors.available ) || BUILT_IN_COLORS.AVAILABLE,
      blocked:
        normalizeHex( settings.colors && settings.colors.blocked ) || BUILT_IN_COLORS.BLOCKED
    };
    /*
      The two default colours use the same swatch row as a block;
      here "Default" means the built-in green or red.
    */
    renderColorSwatches(
      $('settingAvailableColor'),
      {
        selected:
          state.settingsColors.available === BUILT_IN_COLORS.AVAILABLE
            ? null
            : state.settingsColors.available,
        defaultColor:
          BUILT_IN_COLORS.AVAILABLE,
        onPick:
          (hex) => {
            state.settingsColors.available =
              hex || BUILT_IN_COLORS.AVAILABLE;
          }
      }
    );
    renderColorSwatches(
      $('settingBlockedColor'),
      {
        selected:
          state.settingsColors.blocked === BUILT_IN_COLORS.BLOCKED
            ? null
            : state.settingsColors.blocked,
        defaultColor:
          BUILT_IN_COLORS.BLOCKED,
        onPick:
          (hex) => {
            state.settingsColors.blocked =
              hex || BUILT_IN_COLORS.BLOCKED;
          }
      }
    );
    const labels =
      settings.labels || {};
    $('settingLabelAvailable').value =
      labels.available || '';
    $('settingLabelBlocked').value =
      labels.blocked || '';
    $('settingLabelPerson').value =
      labels.person || '';
    $('settingLabelPeople').value =
      labels.people || '';
    $('settingNotificationEmail').value =
      settings.notificationEmail || '';
    openModal( 'settingsModal' );
    $('settingTitle').focus();
  }

  /*
    Email: whether the site can send at all, and whether the last
    notification went out. The dialog shows it; the banner shows a
    failure until it is dismissed or the next send succeeds.
  */
  function renderMailStatus(
    mail,
    address
  ) {
    const line =
      $('mailStatusText');
    const button =
      $('testMailBtn');
    if ( !mail || !mail.configured ) {
      line.textContent =
        t( 'mail_not_set_up' );
      line.className =
        'mail-status';
      button.disabled =
        true;
      return;
    }
    button.disabled =
      false;
    if ( mail.lastError ) {
      line.textContent =
        t( 'last_mail_failed', { error: mail.lastError.message } );
      line.className =
        'mail-status bad';
    } else if ( address ) {
      line.textContent =
        t( 'mail_goes_to', { address } );
      line.className =
        'mail-status ok';
    } else {
      line.textContent =
        t( 'mail_enter_address' );
      line.className =
        'mail-status';
    }
  }

  function applyMailStatus(
    mail
  ) {
    if ( !state.isAdmin || !mail || !mail.lastError ) {
      return;
    }
    if ( state.dismissedMailError === mail.lastError.at ) {
      return;
    }
    $('mailNoticeText').textContent =
      t( 'mail_failed_notice', { error: mail.lastError.message } );
    $('mailNotice')
      .classList
      .remove( 'hidden' );
    state.shownMailError =
      mail.lastError.at;
  }

  function hideMailNotice() {
    state.dismissedMailError =
      state.shownMailError;
    $('mailNotice')
      .classList
      .add( 'hidden' );
  }

  async function sendTestMail() {
    const line =
      $('mailStatusText');
    const button =
      $('testMailBtn');
    const typed =
      $('settingNotificationEmail').value.trim();
    /*
      The test goes to the SAVED address; an unsaved change is saved
      first so the test means what the admin sees.
    */
    button.disabled =
      true;
    line.textContent =
      'Sending…';
    line.className =
      'mail-status';
    try {
      if ( typed ) {
        await api(
          '/settings',
          {
            method:
              'PUT',
            body:
              JSON.stringify({ notificationEmail: typed })
          }
        );
      }
      const data =
        await api(
          '/settings/testmail',
          {
            method:
              'POST'
          }
        );
      line.textContent =
        t( 'test_sent', { address: data.to } );
      line.className =
        'mail-status ok';
      hideMailNotice();
    } catch (error) {
      line.textContent =
        t( 'test_failed', { error: error.message } );
      line.className =
        'mail-status bad';
    } finally {
      button.disabled =
        false;
    }
  }

  async function saveSettings() {
    $('settingsError').textContent = '';
    const body = {
      title:
        $('settingTitle').value,
      displayName:
        $('settingDisplayName').value,
      timezoneId:
        $('settingTimezone').value,
      dayStart:
        Number( $('settingDayStart').value ),
      dayEnd:
        Number( $('settingDayEnd').value ),
      colors:
        { ...state.settingsColors },
      labels: {
        available:
          $('settingLabelAvailable').value,
        blocked:
          $('settingLabelBlocked').value,
        person:
          $('settingLabelPerson').value,
        people:
          $('settingLabelPeople').value
      },
      notificationEmail:
        $('settingNotificationEmail').value,
      slug:
        $('settingSlug').value.trim().toLowerCase(),
      googleCalendarId:
        $('settingGoogleCalendarId').value.trim(),
      weekStart:
        Number( $('settingWeekStart').value ),
      hourFormat:
        $('settingHourFormat').value,
      font:
        $('settingFont').value,
      language:
        $('settingLanguage').value,
      requests: {
        enabled:
          $('settingRequestsEnabled').checked,
        intro:
          $('settingRequestIntro').value,
        minNoticeHours:
          Number( $('settingMinNotice').value ),
        maxWeeksAhead:
          Number( $('settingMaxWeeks').value ),
        minMinutes:
          Number( $('settingMinMinutes').value ),
        maxMinutes:
          Number( $('settingMaxMinutes').value )
      },
      privacy: {
        showBooked:
          $('settingShowBooked').checked
      },
      categories:
        ( state.settingsCategories || [] )
          .map(
            (category) => ({
              id: category.id,
              name: category.name.trim()
            })
          )
          .filter(
            (category) =>
              category.name
          )
    };
    if ( body.dayEnd <= body.dayStart ) {
      $('settingsError').textContent =
        t( 'day_end_after_start' );
      return;
    }
    $('saveSettingsBtn').disabled = true;
    try {
      const data =
        await api(
          '/settings',
          {
            method:
              'PUT',
            body:
              JSON.stringify( body )
          }
        );
      state.config = {
        ...state.config,
        ...( data.config || {} )
      };
      applyConfigStyling();
      closeModal( 'settingsModal' );
      /*
        A new address: the page moves there without reloading, and the
        session remembers it.
      */
      if ( data.slug && data.slug !== state.calendarSlug ) {
        state.calendarSlug =
          data.slug;
        if ( state.calendar ) {
          state.calendar.slug =
            data.slug;
        }
        if ( state.account ) {
          state.account.slug =
            data.slug;
        }
        if ( state.session ) {
          state.session.slug =
            data.slug;
        }
        window.history.replaceState( null, '', '/' + data.slug + window.location.search );
      }
      await loadWeek();
      setStatus(
        data.sync && data.sync.google === 'failed'
          ? t( 'settings_saved_google_failed', { error: data.sync.error || 'unknown error' } )
          : t( 'settings_saved' )
      );
    } catch (error) {
      $('settingsError').textContent =
        error.message ||
        t( 'settings_not_saved' );
    } finally {
      $('saveSettingsBtn').disabled = false;
    }
  }

  /* =========================================================
     BLOCK COLORS (ADMIN)
  ========================================================= */

  /*
    Visitors see red for a blocked session and green for availability,
    and nothing else. The admin can paint a block any color: a basic
    palette, or any hex color from the browser's own picker. A color
    on a repeating series is a rule layered on it - this event only,
    all Mondays, this and following, or everything - so recoloring
    never splits a series. The server resolves each block's color;
    the client only has to draw it.
  */

  const COLOR_PALETTE = [
    { name: 'Red',    hex: '#b42318' },
    { name: 'Orange', hex: '#c2410c' },
    { name: 'Yellow', hex: '#a16207' },
    { name: 'Green',  hex: '#2f7d4a' },
    { name: 'Teal',   hex: '#0f766e' },
    { name: 'Blue',   hex: '#1d4ed8' },
    { name: 'Purple', hex: '#6d28d9' },
    { name: 'Pink',   hex: '#be185d' },
    { name: 'Brown',  hex: '#7c4a1e' },
    { name: 'Gray',   hex: '#4b5563' }
  ];

  const WEEKDAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday',
    'Thursday', 'Friday', 'Saturday'
  ];

  function defaultColorFor(
    type
  ) {
    const colors =
      state.config.colors || {};
    return normalizeHex(
      type === 'AVAILABLE'
        ? colors.available
        : colors.blocked
    ) || BUILT_IN_COLORS[ type === 'AVAILABLE' ? 'AVAILABLE' : 'BLOCKED' ];
  }

  function normalizeHex(
    value
  ) {
    const hex =
      String( value || '' ).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test( hex )
      ? hex
      : null;
  }

  function hexToRgb(
    hex
  ) {
    return [
      parseInt( hex.slice( 1, 3 ), 16 ),
      parseInt( hex.slice( 3, 5 ), 16 ),
      parseInt( hex.slice( 5, 7 ), 16 )
    ];
  }

  function rgbToHex(
    rgb
  ) {
    return '#' +
      rgb
        .map(
          (part) =>
            Math.max( 0, Math.min( 255, Math.round( part ) ) )
              .toString( 16 )
              .padStart( 2, '0' )
        )
        .join( '' );
  }

  function mixWithWhite(
    rgb,
    amount
  ) {
    return rgb.map(
      (part) =>
        part + ( 255 - part ) * amount
    );
  }

  /*
    Text must stay readable on the tint, so a light pick (a bright
    yellow, say) is darkened for the text and border while the tint
    keeps its hue.
  */
  function readableInk(
    rgb
  ) {
    const [ r, g, b ] = rgb;
    const luminance =
      ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) / 255;
    if ( luminance <= 0.45 ) {
      return rgb;
    }
    const factor =
      0.45 / luminance;
    return rgb.map(
      (part) =>
        part * factor
    );
  }

  /*
    The three shades a card is drawn with, in the same relationship
    the default red and green have: dark ink, a pale tint behind it,
    a mid-tone border.
  */
  function cardShades(
    hex
  ) {
    const rgb =
      hexToRgb( hex );
    if ( isDarkTheme() ) {
      /*
        On a dark surface the roles flip: the text is a lightened
        version of the colour, the tint a deep mix with the surface.
      */
      const surface =
        hexToRgb( '#171d2b' );
      const mix =
        (from, to, amount) =>
          from.map( (part, i) => part + ( to[ i ] - part ) * amount );
      return {
        ink:
          rgbToHex( lightInk( rgb ) ),
        tint:
          rgbToHex( mix( rgb, surface, 0.72 ) ),
        border:
          rgbToHex( mix( rgb, surface, 0.45 ) )
      };
    }
    const ink =
      readableInk( rgb );
    return {
      ink:
        rgbToHex( ink ),
      tint:
        rgbToHex( mixWithWhite( rgb, 0.86 ) ),
      border:
        rgbToHex( mixWithWhite( ink, 0.55 ) )
    };
  }

  /*
    Text on a dark tint must be light: a colour is brightened until
    its luminance is comfortably high, keeping its hue.
  */
  function lightInk(
    rgb
  ) {
    const [ r, g, b ] = rgb;
    const luminance =
      ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) / 255;
    if ( luminance >= 0.62 ) {
      return rgb;
    }
    const amount =
      Math.min( 0.9, ( 0.62 - luminance ) / Math.max( 0.05, 1 - luminance ) );
    return mixWithWhite( rgb, amount );
  }

  /* =========================================================
     THEME (LIGHT / DARK)
  ========================================================= */

  /*
    A per-device choice: light, dark, or nothing (the device's own
    preference). Stored in the browser, applied to the root element;
    everything that computes a colour in script is redrawn.
  */
  function isDarkTheme() {
    const chosen =
      document.documentElement.getAttribute( 'data-theme' );
    if ( chosen === 'dark' ) return true;
    if ( chosen === 'light' ) return false;
    return Boolean(
      window.matchMedia &&
      window.matchMedia( '(prefers-color-scheme: dark)' ).matches
    );
  }

  function applyTheme(
    theme
  ) {
    if ( theme === 'dark' || theme === 'light' ) {
      document.documentElement.setAttribute( 'data-theme', theme );
      try {
        localStorage.setItem( 'theme', theme );
      } catch {}
    } else {
      document.documentElement.removeAttribute( 'data-theme' );
      try {
        localStorage.removeItem( 'theme' );
      } catch {}
    }
    renderThemeButton();
    applyConfigStyling();
    renderAll();
  }

  function toggleTheme() {
    applyTheme(
      isDarkTheme()
        ? 'light'
        : 'dark'
    );
  }

  function renderThemeButton() {
    const dark =
      isDarkTheme();
    $('themeIcon').textContent =
      dark
        ? '☀'
        : '☾';
    $('themeBtn').title =
      dark
        ? t( 'switch_light' )
        : t( 'switch_dark' );
    $('themeBtn').setAttribute(
      'aria-label',
      $('themeBtn').title
    );
  }

  /*
    Paint one element with an event's color. Only the admin sees
    colors; the public page keeps its two.
  */
  function applyEventColor(
    element,
    event
  ) {
    const hex =
      state.isAdmin
        ? normalizeHex( event && event.color )
        : null;
    if ( !hex ) {
      element.classList.remove( 'tinted' );
      element.style.removeProperty( '--card-ink' );
      element.style.removeProperty( '--card-tint' );
      element.style.removeProperty( '--card-border' );
      return;
    }
    const shades =
      cardShades( hex );
    element.classList.add( 'tinted' );
    element.style.setProperty( '--card-ink', shades.ink );
    element.style.setProperty( '--card-tint', shades.tint );
    element.style.setProperty( '--card-border', shades.border );
  }

  /*
    Forget a preset: locally at once, so the row redraws without it,
    and on the server, so it is gone on every device.
  */
  function forgetCustomColor(
    hex
  ) {
    state.customColors =
      ( state.customColors || [] )
        .filter(
          (entry) =>
            entry !== hex
        );
    api(
      '/customcolors/' +
        encodeURIComponent( hex ),
      {
        method:
          'DELETE'
      }
    ).catch(
      (error) => {
        setStatus( error.message );
      }
    );
  }

  /*
    The shades the screenshot export draws a block in: its own colour
    in admin mode, else the type's default from the settings.
  */
  function exportShades(
    event
  ) {
    return cardShades(
      ( state.isAdmin && normalizeHex( event.color ) ) ||
      defaultColorFor( event.type )
    );
  }

  function colorName(
    hex
  ) {
    const match =
      COLOR_PALETTE.find(
        (entry) =>
          entry.hex === hex
      );
    return match
      ? t( 'color_' + match.name.toLowerCase() )
      : hex.toUpperCase();
  }

  /*
    The swatch row: Default, the palette, and Custom, which opens the
    browser's own color picker (wheel, sliders, hex field - whatever
    it offers). `selected` is a hex or null for the default; onPick
    receives the same.
  */
  function renderColorSwatches(
    container,
    {
      selected,
      defaultColor,
      onPick
    }
  ) {
    container.innerHTML = '';
    container.classList.add( 'color-row' );
    /*
      Every swatch sits on one line - default, palette, presets, "+"
      - that scrolls sideways if it ever has to; the name of the
      selection sits under it.
    */
    const row =
      document.createElement( 'div' );
    row.className =
      'color-swatches';
    container.appendChild( row );
    const pick =
      (hex) => {
        if ( hex === defaultColor ) {
          hex = null;
        }
        onPick( hex );
        renderColorSwatches(
          container,
          {
            selected: hex,
            defaultColor,
            onPick
          }
        );
      };
    const makeSwatch =
      (hex, label, isSelected) => {
        const button =
          document.createElement( 'button' );
        button.type = 'button';
        button.className =
          'color-swatch' +
          ( isSelected ? ' selected' : '' );
        button.title = label;
        button.setAttribute( 'aria-label', label );
        button.setAttribute( 'aria-pressed', isSelected ? 'true' : 'false' );
        button.style.setProperty( '--swatch', hex );
        return button;
      };
    /*
      The default is the type's own colour, so it is offered once,
      under its name: "Default (Red)" on a blocked block, "Default
      (Green)" on availability. The palette entry it duplicates is
      left out, and picking it counts as picking the default.
    */
    if ( selected === defaultColor ) {
      selected = null;
    }
    const defaultLabel =
      t( 'default_color', { name: colorName( defaultColor ) } );
    const defaultSwatch =
      makeSwatch(
        defaultColor,
        defaultLabel,
        selected === null
      );
    defaultSwatch.classList.add( 'is-default' );
    defaultSwatch.dataset.color = '';
    defaultSwatch.addEventListener( 'click', () => pick( null ) );
    row.appendChild( defaultSwatch );
    COLOR_PALETTE.forEach(
      (entry) => {
        if ( entry.hex === defaultColor ) {
          return;
        }
        const swatch =
          makeSwatch(
            entry.hex,
            entry.name,
            selected === entry.hex
          );
        swatch.dataset.color = entry.hex;
        swatch.addEventListener( 'click', () => pick( entry.hex ) );
        row.appendChild( swatch );
      }
    );
    /*
      Saved custom colours come next, in the order they were first
      used, so a colour picked once on one block is a preset on the
      next. A selection that is neither palette nor preset (just
      picked, not yet saved) is shown as a preset too, at the end.
    */
    const inPalette =
      COLOR_PALETTE.some(
        (entry) =>
          entry.hex === selected
      );
    const presets =
      ( state.customColors || [] )
        .filter(
          (hex) =>
            hex !== defaultColor &&
            !COLOR_PALETTE.some( (entry) => entry.hex === hex )
        );
    if ( selected && !inPalette && !presets.includes( selected ) ) {
      presets.push( selected );
    }
    presets.forEach(
      (hex) => {
        const swatch =
          makeSwatch(
            hex,
            hex.toUpperCase(),
            selected === hex
          );
        swatch.classList.add( 'is-preset' );
        swatch.dataset.color = hex;
        swatch.addEventListener( 'click', () => pick( hex ) );
        /*
          A preset can be forgotten from here: a small x on its
          corner. Blocks already painted with it keep their colour;
          it just stops being offered. If it was the selection, the
          selection falls back to the default.
        */
        const remove =
          document.createElement( 'span' );
        remove.className =
          'color-preset-remove';
        remove.textContent = '×';
        remove.title =
          t( 'remove_preset' );
        remove.setAttribute( 'role', 'button' );
        remove.setAttribute( 'aria-label', t( 'remove_preset_named', { name: hex.toUpperCase() } ) );
        remove.addEventListener( 'click', (clickEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
          forgetCustomColor( hex );
          pick(
            selected === hex
              ? null
              : selected
          );
        });
        swatch.appendChild( remove );
        row.appendChild( swatch );
      }
    );
    /*
      Custom: a native colour input dressed as a "+" swatch that
      opens the browser's own picker.
    */
    const custom =
      document.createElement( 'label' );
    custom.className =
      'color-swatch color-custom';
    custom.title =
      t( 'custom_color_more' );
    const input =
      document.createElement( 'input' );
    input.type = 'color';
    input.className = 'color-custom-input';
    input.setAttribute( 'aria-label', t( 'custom_color' ) );
    input.value =
      selected || defaultColor;
    /*
      "input" fires on every drag of the picker; a full re-render on
      each would tear the picker down. Record the colour as it moves,
      show it on the "+" swatch meanwhile, and redraw once the picker
      closes - at which point it stands as a preset.
    */
    input.addEventListener( 'input', () => {
      const hex =
        normalizeHex( input.value );
      if ( hex ) {
        onPick( hex );
        custom.classList.add( 'selected', 'has-color' );
        custom.style.setProperty( '--swatch', hex );
        container
          .querySelectorAll( '.color-swatch:not(.color-custom)' )
          .forEach(
            (swatch) => {
              swatch.classList.remove( 'selected' );
              swatch.setAttribute( 'aria-pressed', 'false' );
            }
          );
      }
    });
    input.addEventListener( 'change', () => {
      const hex =
        normalizeHex( input.value );
      if ( hex ) {
        pick( hex );
      }
    });
    const plus =
      document.createElement( 'span' );
    plus.className = 'color-custom-mark';
    plus.textContent = '+';
    custom.append( input, plus );
    row.appendChild( custom );
    const caption =
      document.createElement( 'span' );
    caption.className = 'color-caption';
    caption.textContent =
      selected
        ? colorName( selected )
        : defaultLabel;
    container.appendChild( caption );
  }

  /*
    The scopes a recolor (or a deletion) can reach on a series. "All
    Mondays" is offered only when the series meets on more than one
    weekday - on a one-day series it is the whole series.
  */
  /*
    A weekday's name in the language on screen.
  */
  function weekdayName(
    index
  ) {
    return t( 'weekday_names' )[ index ] || WEEKDAY_NAMES[ index ];
  }


  function seriesScopeChoices(
    original,
    occurrence,
    verbs
  ) {
    const choices = [
      {
        label: verbs.one,
        value: 'one'
      },
      {
        label: verbs.following,
        value: 'following'
      }
    ];
    const weekdays =
      ( original.recurrence && original.recurrence.weekdays ) || [];
    if ( weekdays.length > 1 && occurrence ) {
      const weekday =
        weekdayName(
          new Date(
            occurrence.start.slice( 0, 10 ) + 'T12:00'
          ).getDay()
        );
      choices.push({
        label:
          verbs.weekday.replace( '%s', weekday ),
        value: 'weekday'
      });
    }
    choices.push({
      label: verbs.all,
      value: 'all'
    });
    return choices;
  }

  /*
    The Customize dialog from a block's menu: swatches, and for a series
    the reach. Choosing the swatch is not the commitment; Apply is.
  */
  async function openColorDialog(
    original,
    occurrence
  ) {
    const clicked =
      occurrence || original;
    const id =
      original.masterId ||
      original.id;
    let chosen =
      normalizeHex( clicked.color ) || null;
    const swatches =
      document.createElement( 'div' );
    renderColorSwatches(
      swatches,
      {
        selected: chosen,
        defaultColor:
          defaultColorFor( original.type ),
        onPick:
          (hex) => {
            chosen = hex;
          }
      }
    );
    const recurring =
      Boolean( original.recurrence );
    const scope =
      await siteDialog({
        title:
          t( 'customize' ),
        message:
          ( original.title || t( 'this_event' ) ) +
          ( recurring
            ? ' — ' + occurrenceLabel( clicked )
            : '' ),
        content:
          swatches,
        wide:
          true,
        mode:
          'radio',
        defaultValue:
          recurring
            ? 'one'
            : 'all',
        choices:
          recurring
            ? seriesScopeChoices(
                original,
                clicked,
                {
                  one: t( 'this_event_only' ),
                  following: t( 'this_and_following' ),
                  weekday: t( 'all_weekday' ).replace( '{weekday}', '%s' ),
                  all: t( 'all_in_series' )
                }
              )
            : [],
        okLabel:
          t( 'apply' )
      });
    if ( !scope ) {
      return false;
    }
    await applyColor(
      id,
      chosen,
      scope,
      clicked
    );
    return true;
  }

  async function applyColor(
    id,
    color,
    scope,
    occurrence
  ) {
    try {
      const message =
        await requestColor(
          id,
          color,
          scope,
          occurrence
        );
      await loadWeek();
      setStatus(
        message
      );
    } catch (error) {
      setStatus( error.message );
    }
  }

  async function requestColor(
    id,
    color,
    scope,
    occurrence
  ) {
    beginAction(
      scope === 'all' || !occurrence
        ? 'recolor'
        : 'recolor ' + (
            scope === 'one'
              ? "this week's session"
              : scope === 'weekday'
                ? 'all ' + WEEKDAY_NAMES[ new Date( occurrence.start.slice( 0, 10 ) + 'T12:00' ).getDay() ] + 's'
                : 'this and following sessions'
          )
    );
    await api(
      '/events/' +
        encodeURIComponent( id ) +
        '/color',
      {
        method:
          'POST',
        body:
          JSON.stringify({
            color,
            scope,
            date:
              occurrence
                ? occurrence.start.slice( 0, 10 )
                : undefined
          })
      }
    );
    return color
      ? t( 'color_set_to', { name: colorName( color ) } )
      : t( 'back_to_default_color' );
  }

  /*
    Did the editor change anything but the swatch? If not, a series is
    recolored through its rules rather than edited - so "this event
    only" paints one block instead of detaching it.
  */
  function onlyColorChanged(
    original,
    occurrence,
    formEvent
  ) {
    const same =
      (a, b) =>
        String( a || '' ) === String( b || '' );
    const shape =
      (recurrence) =>
        JSON.stringify({
          interval:
            ( recurrence && recurrence.interval ) || 1,
          weekdays:
            [ ...( ( recurrence && recurrence.weekdays ) || [] ) ].sort(),
          endType:
            ( recurrence && recurrence.endType ) || 'NEVER',
          until:
            ( recurrence && recurrence.until ) || null,
          count:
            ( recurrence && recurrence.count ) || null
        });
    return (
      'color' in formEvent &&
      formEvent.type === original.type &&
      same( formEvent.title, original.title ) &&
      same( formEvent.notes, original.notes ) &&
      formEvent.start === occurrence.start &&
      formEvent.end === occurrence.end &&
      shape( formEvent.recurrence ) === shape( original.recurrence )
    );
  }

  /*
    "Delete all Mondays": the series keeps its other days.
  */
  async function deleteWeekdayFromSeries(
    original,
    occurrence
  ) {
    const weekday =
      new Date(
        occurrence.start.slice( 0, 10 ) + 'T12:00'
      ).getDay();
    beginAction( 'delete all ' + WEEKDAY_NAMES[ weekday ] + 's' );
    try {
      await api(
        '/events/' +
          encodeURIComponent( original.masterId || original.id ) +
          '/weekday',
        {
          method:
            'POST',
          body:
            JSON.stringify({ weekday })
        }
      );
      await loadWeek();
      setStatus(
        t( 'removed_weekday', { weekday: weekdayName( weekday ) } )
      );
    } catch (error) {
      setStatus( error.message );
    }
  }

  /*
    The editor's color row. The color the editor opened with is
    remembered so a save can tell an untouched color (say nothing;
    the server keeps what it has) from a deliberate change.
  */
  function setEditorColor(
    color,
    type
  ) {
    state.editorColor =
      normalizeHex( color ) || null;
    state.editorColorLoaded =
      state.editorColor;
    renderEditorColorRow(
      type
    );
  }

  function renderEditorColorRow(
    type
  ) {
    const row =
      $('eventColorRow');
    if ( !row ) {
      return;
    }
    renderColorSwatches(
      row,
      {
        selected:
          state.editorColor,
        defaultColor:
          defaultColorFor(
            type ||
            $('eventType').value
          ),
        onPick:
          (hex) => {
            state.editorColor = hex;
          }
      }
    );
  }

  function editorColorTouched() {
    return (
      ( state.editorColor || null ) !==
      ( state.editorColorLoaded || null )
    );
  }

  /* =========================================================
     REMEMBERED DEVICE
  ========================================================= */

  const DEVICE_TOKEN_KEY =
    'adminDeviceToken';


  function rememberDevice(
    token,
    expiresAt
  ) {

    state.adminToken =
      token;


    state.adminPassword =
      '';


    try {

      localStorage.setItem(
        DEVICE_TOKEN_KEY,
        JSON.stringify({
          token,
          expiresAt
        })
      );

    } catch {

      /* private mode or storage off: signed in for this page only */

    }

  }


  function forgetDevice() {

    state.adminToken =
      null;


    try {

      localStorage.removeItem(
        DEVICE_TOKEN_KEY
      );

    } catch {

      /* nothing stored */

    }

  }


  function rememberedDeviceToken() {

    try {

      const raw =
        localStorage.getItem(
          DEVICE_TOKEN_KEY
        );


      if ( !raw ) {

        return null;

      }


      const saved =
        JSON.parse(
          raw
        );


      if (
        !saved.token ||
        (
          saved.expiresAt &&
          new Date( saved.expiresAt ).getTime() < Date.now()
        )
      ) {

        forgetDevice();

        return null;

      }


      return saved.token;

    } catch {

      return null;

    }

  }


  /*
    On load, a remembered device starts in admin mode; the first
    reload answers "public" if the token has died (password changed,
    or expired), and the page simply falls back to the public view.
  */

  function resumeRememberedDevice() {

    /*
      An account session opens in admin mode; if this turns out to be
      someone else's calendar the first load steps back to visitor.
    */
    const session =
      window.CalendarSession.read();


    if ( session ) {

      state.session =
        session;

      state.isAdmin =
        true;

      return;

    }


    const token =
      rememberedDeviceToken();


    if ( !token ) {

      return;

    }


    state.adminToken =
      token;


    state.isAdmin =
      true;

  }



  /* =========================================================
     RECURRENCE FORM
  ========================================================= */


  /*
    The admin editor and the public request
    form offer the same weekly options, so
    they share these helpers. Each one is
    given the form it should work inside,
    and finds the controls by role rather
    than by id, because the two forms cannot
    share ids.
  */

  function repeatTypeField(
    root
  ) {

    return root.querySelector(
      '[data-repeat-type]'
    );

  }



  function getSelectedWeekdays(
    root
  ) {

    return [
      ...root.querySelectorAll(
        '.weekday-btn.selected'
      )
    ]
      .map(
        (button) =>
          Number(
            button.dataset.day
          )
      )
      .sort(
        (a, b) =>
          a -
          b
      );

  }



  function setSelectedWeekdays(
    root,
    days
  ) {

    const selected =
      new Set(
        (
          days ||
          []
        ).map(
          Number
        )
      );


    root
      .querySelectorAll(
        '.weekday-btn'
      )
      .forEach(
        (button) => {

          button
            .classList
            .toggle(
              'selected',

              selected.has(
                Number(
                  button.dataset.day
                )
              )
            );

        }
      );

  }



  function getStartWeekday(
    root
  ) {

    const key =
      localDateTimeToMinuteKey(
        root.querySelector(
          '[data-recurrence-start]'
        )
          .value
      );


    if (
      key ==
      null
    ) {

      return new Date()
        .getDay();

    }


    return new Date(
      key *
      60000
    )
      .getUTCDay();

  }



  function selectStartWeekday(
    root
  ) {

    setSelectedWeekdays(
      root,
      [
        getStartWeekday(
          root
        )
      ]
    );

  }



  function getRepeatEndType(
    root
  ) {

    return (
      root.querySelector(
        'input[data-repeat-end]:checked'
      )?.value ||
      'NEVER'
    );

  }



  function setRepeatEndType(
    root,
    type
  ) {

    const radio =
      root.querySelector(
        `input[data-repeat-end][value="${type}"]`
      );


    if (
      radio
    ) {

      radio.checked =
        true;

    }

  }



  function updateRecurrenceUI(
    root
  ) {

    const weekly =
      repeatTypeField(
        root
      )
        .value ===
      'WEEKLY';


    root.querySelector(
      '.recurrence-panel'
    )
      .classList
      .toggle(
        'hidden',
        !weekly
      );


    if (
      !weekly
    ) {

      return;

    }


    const endType =
      getRepeatEndType(
        root
      );


    root.querySelector(
      '[data-repeat-end-date]'
    )
      .disabled =
        endType !==
        'ON';


    root.querySelector(
      '[data-repeat-count]'
    )
      .disabled =
        endType !==
        'COUNT';

  }



  /*
    Reset the panel to a sensible starting
    point: not repeating, and if it is turned
    on, on the day already chosen.
  */

  function resetRecurrenceControls(
    root
  ) {

    repeatTypeField(
      root
    )
      .value =
        'NONE';


    root.querySelector(
      '[data-repeat-interval]'
    )
      .value =
        1;


    setSelectedWeekdays(
      root,
      [
        getStartWeekday(
          root
        )
      ]
    );


    setRepeatEndType(
      root,
      'NEVER'
    );


    root.querySelector(
      '[data-repeat-end-date]'
    )
      .value =
        '';


    root.querySelector(
      '[data-repeat-count]'
    )
      .value =
        10;


    updateRecurrenceUI(
      root
    );

  }



  function bindRecurrenceControls(
    root,
    onChange
  ) {

    const changed =
      () => {

        if (
          onChange
        ) {

          onChange();

        }

      };


    const defaultWeekday =
      () => {

        if (
          repeatTypeField(
            root
          )
            .value ===
            'WEEKLY' &&
          getSelectedWeekdays(
            root
          ).length === 0
        ) {

          selectStartWeekday(
            root
          );

        }

      };


    repeatTypeField(
      root
    )
      .addEventListener(
        'change',
        () => {

          defaultWeekday();

          updateRecurrenceUI(
            root
          );

          changed();

        }
      );


    root
      .querySelectorAll(
        '.weekday-btn'
      )
      .forEach(
        (button) => {

          button.addEventListener(
            'click',
            () => {

              button
                .classList
                .toggle(
                  'selected'
                );

              changed();

            }
          );

        }
      );


    root
      .querySelectorAll(
        'input[data-repeat-end]'
      )
      .forEach(
        (radio) => {

          radio.addEventListener(
            'change',
            () => {

              updateRecurrenceUI(
                root
              );

              changed();

            }
          );

        }
      );


    root.querySelector(
      '[data-recurrence-start]'
    )
      .addEventListener(
        'change',
        defaultWeekday
      );

  }


  function getRecurrenceFromForm(
    root
  ) {

    if (
      repeatTypeField(
        root
      )
        .value ===
      'NONE'
    ) {

      return null;

    }


    const weekdays =
      getSelectedWeekdays(
        root
      );


    if (
      !weekdays.length
    ) {

      throw new Error(
        t( 'select_weekday' )
      );

    }


    const interval =
      Number(
        root.querySelector(
          '[data-repeat-interval]'
        )
          .value
      );


    if (
      !Number.isInteger(
        interval
      ) ||
      interval <
        1 ||
      interval >
        52
    ) {

      throw new Error(
        t( 'interval_range' )
      );

    }


    const endType =
      getRepeatEndType(
        root
      );


    const recurrence = {

      frequency:
        'WEEKLY',

      interval,

      weekdays,

      endType

    };


    if (
      endType ===
      'ON'
    ) {

      if (
        !root.querySelector(
          '[data-repeat-end-date]'
        )
          .value
      ) {

        throw new Error(
          t( 'choose_end_date' )
        );

      }


      recurrence.until =
        root.querySelector(
          '[data-repeat-end-date]'
        )
          .value;

    }


    if (
      endType ===
      'COUNT'
    ) {

      const count =
        Number(
          root.querySelector(
            '[data-repeat-count]'
          )
            .value
        );


      if (
        !Number.isInteger(
          count
        ) ||
        count <
          1 ||
        count >
          999
      ) {

        throw new Error(
          t( 'occurrences_range' )
        );

      }


      recurrence.count =
        count;

    }


    return recurrence;

  }



  /* =========================================================
     EVENT MODAL
  ========================================================= */


  function openEventModal(
    event,
    occurrence
  ) {

    endAction();


    if (
      !state.isAdmin
    ) {

      return;

    }


    const isEdit =
      Boolean(
        event &&
        event.id
      );


    /*
      Opening the editor for anything else
      releases whatever request was being
      reviewed.
    */

    state.acceptedRequestId =
      null;


    /*
      Which week's card opened this editor, when one did. The scoped
      delete inside the modal needs the clicked date, because "just
      this block" means the block that was clicked, not the week the
      series happens to start in.
    */

    state.editingOccurrence =
      occurrence ||
      null;


    /*
      And the record itself. Opened from the Blocked Sessions list or
      from another week, the series may not be among this week's
      loaded events, and the scope dialogs still need its master.
    */

    state.editingEvent =
      event ||
      null;


    const defaultDate =
      formatDate(
        new Date()
      );


    const defaultStart =
      defaultDate +
      'T15:00';


    const defaultEnd =
      defaultDate +
      'T16:00';


    /*
      Opened from a card of a series, the editor shows THAT week's
      date and time - the scope question at save decides how far the
      change reaches. Without a clicked occurrence it falls back to
      the series anchor as before.
    */

    const originalStart =
      (
        occurrence &&
        occurrence.start
      ) ||
      (
        event &&
        (
          event.seriesStart ||
          event.start
        )
      ) ||
      defaultStart;


    const originalEnd =
      (
        occurrence &&
        occurrence.end
      ) ||
      (
        event &&
        (
          event.seriesEnd ||
          event.end
        )
      ) ||
      defaultEnd;


    $('eventModalTitle')
      .textContent =
        isEdit
          ? (
              event.recurrence
                ? t( 'edit_recurring' )
                : t( 'edit_event' )
            )
          : t( 'add_event' );


    $('eventId')
      .value =
        isEdit
          ? (
              event.masterId ||
              event.id
            )
          : '';


    /*
      New events intentionally
      begin with Select One.
    */

    $('eventType')
      .value =
        (
          event &&
          event.type
        ) ||
        '';
    /*
      The colour of the block that was opened - the clicked
      occurrence when there is one, since a series can wear a
      different colour on different days.
    */
    setEditorColor(
      occurrence
        ? occurrence.color
        : ( event && event.color ),
      ( event && event.type ) || ''
    );
    setDateTimeValue(
      'eventStart',
      originalStart
    );


    setDateTimeValue(
      'eventEnd',
      originalEnd
    );


    $('eventTitle')
      .value =
        (
          event &&
          event.title
        ) ||
        '';


    $('eventNotes')
      .value =
        (
          event &&
          event.notes
        ) ||
        '';


    $('eventGoogleTitle')
      .value =
        (
          event &&
          event.googleTitle
        ) ||
        '';
    syncGoogleTitleField();
    fillCategorySelect(
      ( event && event.category ) || ''
    );
    syncCategoryField();


    $('eventError')
      .textContent =
        '';


    clearConflictWarning();


    $('deleteEventBtn')
      .classList
      .toggle(
        'hidden',
        !isEdit
      );


    const recurrence =
      event?.recurrence ||
      null;


    if (
      recurrence?.frequency ===
      'WEEKLY'
    ) {

      $('repeatType')
        .value =
          'WEEKLY';


      $('repeatInterval')
        .value =
          recurrence.interval ||
          1;


      setSelectedWeekdays(
        $('eventModal'),
        recurrence.weekdays ||
        []
      );


      setRepeatEndType(
        $('eventModal'),
        recurrence.endType ||
        'NEVER'
      );


      $('repeatEndDate')
        .value =
          recurrence.until ||
          '';


      $('repeatCount')
        .value =
          recurrence.count ||
          10;

    } else {

      $('repeatType')
        .value =
          'NONE';


      $('repeatInterval')
        .value =
          1;


      setSelectedWeekdays(
        $('eventModal'),
        [
          getStartWeekday(
            $('eventModal')
          )
        ]
      );


      setRepeatEndType(
        $('eventModal'),
        'NEVER'
      );


      $('repeatEndDate')
        .value =
          '';


      $('repeatCount')
        .value =
          10;

    }


    updateRecurrenceUI(
      $('eventModal')
    );


    openModal(
      'eventModal'
    );

  }



  /* =========================================================
     INLINE CONFLICT WARNING
  ========================================================= */


  function clearConflictWarning() {

    state.pendingConflictEvent =
      null;


    $('conflictWarning')
      .classList
      .add(
        'hidden'
      );


    $('conflictWarningSummary')
      .textContent =
        '';


    $('conflictWarningList')
      .innerHTML =
        '';


    $('saveAnywayBtn')
      .classList
      .add(
        'hidden'
      );


    $('saveEventBtn')
      .classList
      .remove(
        'hidden'
      );

  }



  function showConflictWarning(
    data,
    event
  ) {

    state.pendingConflictEvent =
      event;


    const conflicts =
      data.conflicts ||
      [];


    const total =
      data.totalConflicts ||
      conflicts.length;


    $('eventError')
      .textContent =
        '';


    $('conflictWarningSummary')
      .textContent =
        total ===
        1
          ? t( 'overlaps_one' )
          : t( 'overlaps_many', { total } );


    const list =
      $('conflictWarningList');


    list.innerHTML =
      '';


    const shown =
      conflicts.slice(
        0,
        6
      );


    for (
      const conflict of
      shown
    ) {

      const item =
        document.createElement(
          'div'
        );


      item.className =
        'conflict-item';


      const title =
        document.createElement(
          'div'
        );


      title.className =
        'conflict-item-title';


      title.textContent =
        conflict.title ||
        labelFor( 'BLOCKED' );


      const time =
        document.createElement(
          'div'
        );


      time.className =
        'conflict-item-time';


      time.textContent =
        formatBlockedEventRange(
          conflict.start,
          conflict.end
        );


      item.append(
        title,
        time
      );


      list.appendChild(
        item
      );

    }


    if (
      total >
      shown.length
    ) {

      const more =
        document.createElement(
          'div'
        );


      more.className =
        'conflict-more';


      const remaining =
        total -
        shown.length;


      more.textContent =
        t( 'more_conflicts', { n: remaining } );


      list.appendChild(
        more
      );

    }


    $('conflictWarning')
      .classList
      .remove(
        'hidden'
      );


    /*
      Replace normal Save button
      with Save Anyway.
    */

    $('saveEventBtn')
      .classList
      .add(
        'hidden'
      );


    $('saveAnywayBtn')
      .classList
      .remove(
        'hidden'
      );


    $('conflictWarning')
      .scrollIntoView({
        behavior:
          'smooth',

        block:
          'nearest'
      });

  }



  async function saveAnywayFromConflict() {

    const event =
      state.pendingConflictEvent;


    if (
      !event
    ) {

      return;

    }


    $('eventError')
      .textContent =
        '';


    $('saveAnywayBtn')
      .disabled =
        true;


    try {

      if ( event.seriesScope ) {

        /*
          A series edit that clashed: the same scope, this time with
          the check waived.
        */
        const { seriesScope, ...formEvent } = event;
        const outcome =
          await saveSeriesEditWithScope(
            {
              ...formEvent,
              forceConflict:
                true
            },
            seriesScope
          );
        if ( !outcome ) {
          return;
        }
        clearConflictWarning();
        closeModal(
          'eventModal'
        );
        await clearAcceptedRequest();
        await loadWeek();
        setStatus(
          outcome
        );
        return;

      }


      await api(
        '/events',
        {
          method:
            'POST',

          body:
            JSON.stringify({
              ...event,

              forceConflict:
                true
            })
        }
      );


      clearConflictWarning();


      closeModal(
        'eventModal'
      );


      await clearAcceptedRequest();


      await loadWeek();

    } catch (error) {

      $('eventError')
        .textContent =
          error.message;

    } finally {

      $('saveAnywayBtn')
        .disabled =
          false;

    }

  }



  /* =========================================================
     SAVE EVENT
  ========================================================= */


  async function saveEventFromModal() {

    /*
      Clear any existing standard
      validation error.
    */

    $('eventError')
      .textContent =
        '';


    clearConflictWarning();


    const type =
      $('eventType')
        .value;


    const title =
      $('eventTitle')
        .value
        .trim();


    /*
      TYPE REQUIRED
    */

    if (
      !type
    ) {

      $('eventError')
        .textContent =
          t( 'select_type' );


      $('eventType')
        .focus();


      return;

    }


    /*
      TITLE REQUIRED
    */

    if (
      !title
    ) {

      $('eventError')
        .textContent =
          t( 'enter_title' );


      $('eventTitle')
        .focus();


      return;

    }


    const start =
      $('eventStart')
        .value;


    const end =
      $('eventEnd')
        .value;


    const startKey =
      localDateTimeToMinuteKey(
        start
      );


    const endKey =
      localDateTimeToMinuteKey(
        end
      );


    /*
      VALID TIME REQUIRED
    */

    if (
      startKey ==
        null ||
      endKey ==
        null
    ) {

      $('eventError')
        .textContent =
          t( 'valid_datetime' );


      return;

    }


    /*
      END AFTER START
    */

    if (
      endKey <=
      startKey
    ) {

      $('eventError')
        .textContent =
          t( 'end_after_start_dt' );


      return;

    }


    let recurrence;


    try {

      recurrence =
        getRecurrenceFromForm(
          $('eventModal')
        );

    } catch (error) {

      $('eventError')
        .textContent =
          error.message;


      return;

    }


    const event = {
      id:
        $('eventId')
          .value,
      type,
      start,
      end,
      title,
      notes:
        $('eventNotes')
          .value,
      googleTitle:
        $('eventGoogleTitle')
          .value,
      category:
        $('eventCategory')
          .value,
      recurrence
    };
    /*
      Color is sent only when it was chosen here: an untouched
      swatch says nothing, and the server keeps what the block (or
      its series, rules included) already had.
    */
    if (
      editorColorTouched() ||
      (
        !event.id &&
        state.editorColor
      )
    ) {
      event.color =
        state.editorColor;
    }


    /*
      Saving an existing series asks how far the edit reaches - one
      week, from here on, or everything - exactly like deleting one.
      New events, one-time events, and a series being converted away
      from repeating keep the plain save below.
    */

    if (
      event.id &&
      recurrence &&
      await resolveEditingSeries(
        event.id
      )
    ) {

      const outcome =
        await saveSeriesEditWithScope(
          event
        );


      if ( outcome ) {

        closeModal(
          'eventModal'
        );


        await clearAcceptedRequest();


        await loadWeek();


        setStatus(
          outcome
        );

      }


      return;

    }


    $('saveEventBtn')
      .disabled =
        true;


    try {

      /*
        Normal save attempt.
      */

      await api(
        '/events',
        {
          method:
            'POST',

          body:
            JSON.stringify(
              event
            )
        }
      );


      clearConflictWarning();


      closeModal(
        'eventModal'
      );


      await clearAcceptedRequest();


      await loadWeek();

    } catch (error) {

      /*
        Schedule conflict.

        Do not use browser confirm().
        Display the warning in the form.
      */

      if (
        error.status ===
          409 &&
        error.data?.code ===
          'BLOCKED_CONFLICT'
      ) {

        showConflictWarning(
          error.data,
          event
        );


        return;

      }


      $('eventError')
        .textContent =
          error.message;

    } finally {

      $('saveEventBtn')
        .disabled =
          false;

    }

  }



  /* =========================================================
     DELETE
  ========================================================= */


  async function deleteEventFromModal() {

    beginAction( 'delete session' );


    const id =
      $('eventId')
        .value;


    if (
      !id
    ) {

      return;

    }


    const recurring =
      $('repeatType')
        .value ===
      'WEEKLY';


    /*
      The modal's Delete on a series opens the same three-way choice
      the right-click menu offers, so both roads behave identically.
      The stored master supplies the truth about the series; the
      clicked occurrence, remembered when the editor opened, names
      which block "just this one" means.
    */

    if ( recurring ) {

      const series =
        await resolveEditingSeries(
          id
        );


      if ( series ) {

        const acted =
          await confirmScopedDelete(
            series.original,
            series.occurrence
          );


        if ( acted ) {

          closeModal(
            'eventModal'
          );

        }


        return;

      }

    }


    const wanted =
      await siteConfirm(
        recurring
          ? t( 'delete_series_q' )
          : t( 'delete_event_q' ),
        $('eventTitle')
          .value ||
        ''
      );


    if ( !wanted ) {

      return;

    }


    $('deleteEventBtn')
      .disabled =
        true;


    try {

      await api(
        '/events/' +
        encodeURIComponent(
          id
        ),
        {
          method:
            'DELETE'
        }
      );


      closeModal(
        'eventModal'
      );


      await loadWeek();

    } catch (error) {

      $('eventError')
        .textContent =
          error.message;

    } finally {

      $('deleteEventBtn')
        .disabled =
          false;

    }

  }



  /* =========================================================
     DATE DISPLAY
  ========================================================= */


  function formatBlockedEventRange(
    start,
    end
  ) {

    const startKey =
      localDateTimeToMinuteKey(
        start
      );


    const endKey =
      localDateTimeToMinuteKey(
        end
      );


    const startDate =
      new Date(
        startKey *
        60000
      );


    const endDate =
      new Date(
        endKey *
        60000
      );


    const sameDay =
      start.slice(
        0,
        10
      ) ===
      end.slice(
        0,
        10
      );


    const dateText =
      startDate
        .toLocaleDateString(
          I18N.locale(),
          {
            timeZone:
              'UTC',

            weekday:
              'short',

            month:
              'short',

            day:
              'numeric',

            year:
              'numeric'
          }
        );


    const startTime =
      startDate
        .toLocaleTimeString(
          I18N.locale(),
          {
            timeZone:
              'UTC',

            hour12: !is24h(),

            hour:
              'numeric',

            minute:
              '2-digit'
          }
        );


    const endTime =
      endDate
        .toLocaleTimeString(
          I18N.locale(),
          {
            timeZone:
              'UTC',

            hour12: !is24h(),

            hour:
              'numeric',

            minute:
              '2-digit'
          }
        );


    if (
      sameDay
    ) {

      return (
        `${dateText} · ` +
        `${startTime} – ${endTime}`
      );

    }


    const endDateText =
      endDate
        .toLocaleDateString(
          I18N.locale(),
          {
            timeZone:
              'UTC',

            weekday:
              'short',

            month:
              'short',

            day:
              'numeric',

            year:
              'numeric'
          }
        );


    return (
      `${dateText} ${startTime} – ` +
      `${endDateText} ${endTime}`
    );

  }



  /* =========================================================
     PORTAL CURRENT TIME
  ========================================================= */


  function getPortalNowMinuteKey() {

    const timezone =
      state.config
        .timezoneId ||
      'America/Los_Angeles';


    const formatter =
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            timezone,

          year:
            'numeric',

          month:
            '2-digit',

          day:
            '2-digit',

          hour:
            '2-digit',

          minute:
            '2-digit',

          hourCycle:
            'h23'
        }
      );


    const parts =
      formatter
        .formatToParts(
          new Date()
        );


    const values =
      {};


    for (
      const part of
      parts
    ) {

      if (
        part.type !==
        'literal'
      ) {

        values[
          part.type
        ] =
          part.value;

      }

    }


    return localDateTimeToMinuteKey(
      `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
    );

  }



  /* =========================================================
     MODALS
  ========================================================= */


  function openModal(
    id
  ) {

    $(id)
      .classList
      .remove(
        'hidden'
      );

  }



  function closeModal(
    id
  ) {

    $(id)
      .classList
      .add(
        'hidden'
      );

  }



  /* =========================================================
     STATUS
  ========================================================= */


  function setStatus(
    text
  ) {

    $('status')
      .textContent =
        text ||
        '';

  }



  function handleError(
    error
  ) {

    setStatus(
      error.message ||
      String(
        error
      )
    );

  }



  /* =========================================================
     DATE UTILITIES
  ========================================================= */


  function startOfWeek(
    date
  ) {

    const result =
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      );


        /*
      The week starts on the day the settings say: Sunday unless the
      calendar chose Monday.
    */
    const first =
      state.config.weekStart === 1 ? 1 : 0;


    result.setDate(
      result.getDate() -
      ( ( result.getDay() - first + 7 ) % 7 )
    );


    return result;

  }



  function addDays(
    date,
    amount
  ) {

    const result =
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      );


    result.setDate(
      result.getDate() +
      amount
    );


    return result;

  }



  function formatDate(
    date
  ) {

    return (
      `${date.getFullYear()}-` +
      `${String(
        date.getMonth() +
        1
      ).padStart(
        2,
        '0'
      )}-` +
      `${String(
        date.getDate()
      ).padStart(
        2,
        '0'
      )}`
    );

  }



    /*
    "ethans_tutoring_availability 9.13-9.19": the title as a file
    name, then the dates on screen.
  */
  function downloadName() {
    const title =
      ( state.config.portalTitle || 'calendar' )
        .toLowerCase()
        .replace( /['’]/g, '' )
        .replace( /[^a-z0-9]+/g, '_' )
        .replace( /^_+|_+$/g, '' ) || 'calendar';
    const range =
      visibleRange();
    const md =
      (date) => ( date.getMonth() + 1 ) + '.' + date.getDate();
    const last =
      addDays( range.start, range.days - 1 );
    const when =
      state.view === 'month'
        ? ( range.start.getMonth() + 1 ) + '.' + range.start.getFullYear()
        : range.days > 1
          ? md( range.start ) + '-' + md( last )
          : md( range.start );
    return title + ' ' + when;
  }


  /*
    The clock is a setting: "2:30 PM" or "14:30". Every label on the
    page goes through the helpers below, so one flag changes them all.
    In a language other than English the browser writes the 12-hour
    form its own way - "8 a. m.", "上午8时" - so those come from Intl.
  */
  function is24h() {
    return state.config.hourFormat === '24';
  }


  function localizedClock() {
    return !is24h() && window.I18N.get() !== 'en';
  }


  function intlTime(
    minutes,
    withMinutes
  ) {
    const date =
      new Date( 2026, 0, 1, Math.floor( minutes / 60 ), minutes % 60 );
    try {
      return new Intl.DateTimeFormat(
        window.I18N.locale(),
        {
          hour: 'numeric',
          ...( withMinutes ? { minute: '2-digit' } : {} ),
          hour12: true
        }
      ).format( date );
    } catch {
      return null;
    }
  }


  /*
    The time zone's name as the visitor's language gives it, falling
    back to the server's English label.
  */
  function localizedTimezoneLabel() {
    if ( window.I18N.get() === 'en' || !state.config.timezoneId ) {
      return state.config.timezoneLabel;
    }
    try {
      const part =
        new Intl.DateTimeFormat(
          window.I18N.locale(),
          { timeZone: state.config.timezoneId, timeZoneName: 'longGeneric' }
        )
          .formatToParts( new Date() )
          .find( (item) => item.type === 'timeZoneName' );
      return part && part.value ? part.value : state.config.timezoneLabel;
    } catch {
      return state.config.timezoneLabel;
    }
  }


  function formatMinutes(
    minutes
  ) {

    const normalized =
      (
        (
          minutes %
          1440
        ) +
        1440
      ) %
      1440;


    if ( is24h() ) {

      return (
        String( Math.floor( normalized / 60 ) ).padStart( 2, '0' ) +
        ':' +
        String( normalized % 60 ).padStart( 2, '0' )
      );

    }


    if ( localizedClock() ) {

      const text =
        intlTime( normalized, normalized % 60 !== 0 );

      if ( text ) {

        return text;

      }

    }



    const hour24 =
      Math.floor(
        normalized /
        60
      );


    const minute =
      normalized %
      60;


    const suffix =
      hour24 >=
      12
        ? 'PM'
        : 'AM';


    const hour =
      hour24 %
      12 ||
      12;


    return (
      hour +
      (
        minute
          ? ':' +
            String(
              minute
            ).padStart(
              2,
              '0'
            )
          : ''
      ) +
      ' ' +
      suffix
    );

  }



  /*
    Calendar convention: when a range
    stays inside one half of the day
    the opening meridiem is redundant,
    and dropping it leaves room for the
    title on a compact card. Only the
    opening one goes – "11:30 – 12"
    would be ambiguous.
  */

  function formatMinuteRange(
    startMinutes,
    endMinutes
  ) {

    const start =
      formatMinutes(
        startMinutes
      );


    const end =
      formatMinutes(
        endMinutes
      );


        const opening =
      !is24h() &&
      !localizedClock() &&
      start.slice(
        -2
      ) ===
      end.slice(
        -2
      )
        ? start.slice(
            0,
            -3
          )
        : start;



    return (
      opening +
      ' – ' +
      end
    );

  }



  function localDateTimeToMinuteKey(
    value
  ) {

    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
        .exec(
          value ||
          ''
        );


    if (
      !match
    ) {

      return null;

    }


    const year =
      Number(
        match[1]
      );


    const month =
      Number(
        match[2]
      );


    const day =
      Number(
        match[3]
      );


    const hour =
      Number(
        match[4]
      );


    const minute =
      Number(
        match[5]
      );


    if (
      month <
        1 ||
      month >
        12 ||
      hour <
        0 ||
      hour >
        23 ||
      minute <
        0 ||
      minute >
        59
    ) {

      return null;

    }


    const milliseconds =
      Date.UTC(
        year,
        month -
        1,
        day,
        hour,
        minute
      );


    const check =
      new Date(
        milliseconds
      );


    if (
      check.getUTCFullYear() !==
        year ||
      check.getUTCMonth() !==
        month -
        1 ||
      check.getUTCDate() !==
        day ||
      check.getUTCHours() !==
        hour ||
      check.getUTCMinutes() !==
        minute
    ) {

      return null;

    }


    return Math.floor(
      milliseconds /
      60000
    );

  }



  function minuteKeyToLocalDateTime(
    key
  ) {

    const date =
      new Date(
        key *
        60000
      );


    return (
      `${date.getUTCFullYear()}-` +
      `${String(
        date.getUTCMonth() +
        1
      ).padStart(
        2,
        '0'
      )}-` +
      `${String(
        date.getUTCDate()
      ).padStart(
        2,
        '0'
      )}T` +
      `${String(
        date.getUTCHours()
      ).padStart(
        2,
        '0'
      )}:` +
      `${String(
        date.getUTCMinutes()
      ).padStart(
        2,
        '0'
      )}`
    );

  }



  function dateAndMinutesToLocalDateTime(
    dateStr,
    minutes
  ) {

    const dayStart =
      localDateTimeToMinuteKey(
        dateStr +
        'T00:00'
      );


    return minuteKeyToLocalDateTime(
      dayStart +
      minutes
    );

  }



  /*
    Two timestamps are easy to confuse: when
    the tutor last changed the schedule, and
    when this page last asked for it. The
    first names the person, the second is
    relative and borrows the Refresh button's
    wording, so neither can be read as the
    other.
  */

  function renderCheckedLabel() {

    if (
      !state.lastLoadedAt
    ) {

      $('checkedLabel')
        .textContent =
          '';


      return;

    }


    const minutes =
      Math.floor(
        (
          Date.now() -
          state.lastLoadedAt
        ) /
        60000
      );


    if (
      minutes <
      1
    ) {

      $('checkedLabel')
        .textContent =
          t( 'refreshed_now' );


      return;

    }


    if (
      minutes <
      60
    ) {

      $('checkedLabel')
        .textContent =
          t( 'refreshed_min_ago', { minutes } );


      return;

    }


        $('checkedLabel')
      .textContent =
        t( 'refreshed_at', {
          time:
            new Date(
              state.lastLoadedAt
            )
              .toLocaleTimeString(
                I18N.locale(),
                {
                  hour12: !is24h(),
                  hour:
                    'numeric',
                  minute:
                    '2-digit'
                }
              )
        } );

  }



  function formatUpdated(
    iso
  ) {

    const date =
      new Date(
        iso
      );


    return Number.isNaN(
      date.getTime()
    )
      ? iso
      : date.toLocaleString(
          I18N.locale(),
          {
            month:
              'short',

            day:
              'numeric',

            hour12: !is24h(),

            hour:
              'numeric',

            minute:
              '2-digit'
          }
        );

  }



  init();

})();