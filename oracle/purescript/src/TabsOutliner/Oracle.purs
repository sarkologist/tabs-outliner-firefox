module TabsOutliner.Oracle (evaluateRuntimeTraceJson) where

foreign import data Json :: Type

data Maybe a = Nothing | Just a
data Result a = Ok a | Err OracleError

newtype NodeId = NodeId String
newtype TabId = TabId Int
newtype WindowId = WindowId Int

data NodeKind = WindowKind | TabKind | GroupKind
data NodeStatus = LiveStatus | ClosedStatus | NeutralStatus
data RuntimeWindowState = Normal | Minimized | Maximized | Fullscreen | Docked | UnknownWindowState String

data TabSelector
  = TabById TabId
  | TabCapture String
  | TabRole String
  | TabInWindow WindowSelector (Maybe Int)

data WindowSelector
  = WindowById WindowId
  | WindowCapture String
  | WindowRole String

data NodeSelector
  = NodeById NodeId
  | NodeByTab TabSelector
  | NodeByWindow WindowSelector

data Action
  = OpenTab OpenTabAction
  | ActivateTab TabSelector
  | UpdateTab UpdateTabAction
  | FocusWindow WindowSelector
  | NativeSetWindowState WindowSelector RuntimeWindowState
  | NativeOpenWindow NativeOpenWindowAction
  | NativeMoveTabToWindow NativeMoveTabAction
  | NativeMoveTabToNewWindow NativeMoveTabToNewWindowAction
  | OutlinerGroupTab TabSelector
  | OutlinerMoveTabToNewWindow TabSelector
  | OutlinerCloseTab TabSelector
  | OutlinerCloseWindow WindowSelector
  | OutlinerDeleteNode NodeSelector
  | UnsupportedAction String

type OracleError =
  { step :: Maybe Int
  , code :: String
  , message :: String
  }

type RuntimeTab =
  { id :: TabId
  , windowId :: WindowId
  , index :: Int
  , active :: Boolean
  , openerTabId :: Maybe TabId
  , url :: Maybe String
  , title :: Maybe String
  , favIconUrl :: Maybe String
  , incognito :: Boolean
  }

type RuntimeWindow =
  { id :: WindowId
  , focused :: Boolean
  , incognito :: Boolean
  , state :: Maybe RuntimeWindowState
  }

type OutlineNode =
  { id :: NodeId
  , kind :: NodeKind
  , status :: NodeStatus
  , parentId :: Maybe NodeId
  , childIds :: Array NodeId
  , title :: String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , active :: Maybe Boolean
  , liveWindowId :: Maybe WindowId
  , liveTabId :: Maybe TabId
  , restoreSessionId :: Maybe String
  , restoreUrl :: Maybe String
  , restoreTitle :: Maybe String
  , restoreFavIconUrl :: Maybe String
  , runtimeProvenance :: Maybe String
  }

type Outline =
  { rootIds :: Array NodeId
  , nodes :: Array OutlineNode
  }

type OracleModel =
  { now :: Int
  , nextTabId :: Int
  , nextWindowId :: Int
  , runtimeWindows :: Array RuntimeWindow
  , runtimeTabs :: Array RuntimeTab
  , outline :: Outline
  , tabCaptures :: Array (Pair String TabId)
  , windowCaptures :: Array (Pair String WindowId)
  , lastOpenedTabId :: Maybe TabId
  , lastMovedTabId :: Maybe TabId
  , lastOpenedWindowId :: Maybe WindowId
  }

type OracleInput =
  { now :: Int
  , windows :: Array RuntimeWindow
  , tabs :: Array RuntimeTab
  , traceId :: String
  , actions :: Array Action
  }

type OpenTabAction =
  { window :: WindowSelector
  , active :: Maybe Boolean
  , title :: Maybe String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , openerTab :: Maybe TabSelector
  , captureTab :: Maybe String
  , staleQueryFromCapture :: Maybe String
  }

type UpdateTabAction =
  { tab :: TabSelector
  , title :: Maybe String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  }

type NativeOpenWindowTab =
  { active :: Maybe Boolean
  , title :: Maybe String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , openerTab :: Maybe TabSelector
  }

type NativeOpenWindowAction =
  { tabs :: Array NativeOpenWindowTab
  , focused :: Maybe Boolean
  , captureWindow :: Maybe String
  , captureTabs :: Maybe String
  }

type NativeMoveTabAction =
  { tab :: TabSelector
  , window :: WindowSelector
  , index :: Maybe Int
  , active :: Maybe Boolean
  }

type NativeMoveTabToNewWindowAction =
  { tab :: TabSelector
  , active :: Maybe Boolean
  , captureWindow :: Maybe String
  }

type Snapshot =
  { outline :: SnapshotOutline
  , runtime :: SnapshotRuntime
  }

type SnapshotOutline =
  { rootIds :: Array String
  , nodes :: Array SnapshotNode
  }

type SnapshotNode =
  { id :: String
  , kind :: String
  , status :: String
  , parentId :: Maybe String
  , childIds :: Array String
  , title :: String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , active :: Maybe Boolean
  , live :: SnapshotLiveRef
  , restore :: SnapshotRestoreRef
  , runtimeProvenance :: Maybe String
  }

type SnapshotLiveRef =
  { windowId :: Maybe Int
  , tabId :: Maybe Int
  }

type SnapshotRestoreRef =
  { sessionId :: Maybe String
  , url :: Maybe String
  , title :: Maybe String
  , favIconUrl :: Maybe String
  }

type SnapshotRuntime =
  { windows :: Array SnapshotRuntimeWindow
  , tabs :: Array SnapshotRuntimeTab
  }

type SnapshotRuntimeWindow =
  { id :: Int
  , focused :: Boolean
  , incognito :: Boolean
  , state :: Maybe String
  , tabIds :: Array Int
  }

type SnapshotRuntimeTab =
  { id :: Int
  , windowId :: Int
  , index :: Int
  , active :: Boolean
  , openerTabId :: Maybe Int
  , url :: Maybe String
  , title :: Maybe String
  , favIconUrl :: Maybe String
  , incognito :: Boolean
  }

data Pair a b = Pair a b

foreign import parseJsonImpl :: forall r. (String -> r) -> (Json -> r) -> String -> r
foreign import fieldStringImpl :: forall r. r -> (String -> r) -> String -> Json -> r
foreign import fieldIntImpl :: forall r. r -> (Int -> r) -> String -> Json -> r
foreign import fieldBooleanImpl :: forall r. r -> (Boolean -> r) -> String -> Json -> r
foreign import fieldArrayImpl :: forall r. r -> (Array Json -> r) -> String -> Json -> r
foreign import fieldObjectImpl :: forall r. r -> (Json -> r) -> String -> Json -> r
foreign import eqString :: String -> String -> Boolean
foreign import eqInt :: Int -> Int -> Boolean
foreign import notBoolean :: Boolean -> Boolean
foreign import andBoolean :: Boolean -> Boolean -> Boolean
foreign import orBoolean :: Boolean -> Boolean -> Boolean
foreign import addInt :: Int -> Int -> Int
foreign import subInt :: Int -> Int -> Int
foreign import maxInt :: Int -> Int -> Int
foreign import intToString :: Int -> String
foreign import appendString :: String -> String -> String
foreign import mapArray :: forall a b. (a -> b) -> Array a -> Array b
foreign import filterArray :: forall a. (a -> Boolean) -> Array a -> Array a
foreign import foldlArray :: forall a b. (b -> a -> b) -> b -> Array a -> b
foreign import anyArray :: forall a. (a -> Boolean) -> Array a -> Boolean
foreign import lengthArray :: forall a. Array a -> Int
foreign import snocArray :: forall a. Array a -> a -> Array a
foreign import appendArray :: forall a. Array a -> Array a -> Array a
foreign import indexArrayImpl :: forall a r. r -> (a -> r) -> Int -> Array a -> r
foreign import findArrayImpl :: forall a r. r -> (a -> r) -> (a -> Boolean) -> Array a -> r
foreign import findIndexArrayImpl :: forall a r. r -> (Int -> r) -> (a -> Boolean) -> Array a -> r
foreign import sortWindows :: Array RuntimeWindow -> Array RuntimeWindow
foreign import sortTabs :: Array RuntimeTab -> Array RuntimeTab
foreign import sortNodes :: Array SnapshotNode -> Array SnapshotNode
foreign import stringifyOk :: Array Snapshot -> String
foreign import stringifyErr :: OracleError -> String

evaluateRuntimeTraceJson :: String -> String
evaluateRuntimeTraceJson inputJson =
  case parseInput inputJson of
    Err error -> stringifyErr error
    Ok input ->
      case runInput input of
        Err error -> stringifyErr error
        Ok snapshots -> stringifyOk snapshots

parseInput :: String -> Result OracleInput
parseInput inputJson =
  bindResult (parseJson inputJson) decodeInput

parseJson :: String -> Result Json
parseJson inputJson =
  parseJsonImpl
    (\message -> Err (oracleError Nothing "invalid-json" message))
    Ok
    inputJson

decodeInput :: Json -> Result OracleInput
decodeInput json =
  bindResult (requireInt "version" json) (\version ->
    if eqInt version 1 then
      bindResult (requireObject "initial" json) (\initial ->
        bindResult (requireObject "trace" json) (\trace ->
          bindResult (requireInt "now" initial) (\now ->
            bindResult (decodeArray decodeWindow "windows" initial) (\windows ->
              bindResult (decodeArray decodeTab "tabs" initial) (\tabs ->
                bindResult (requireString "id" trace) (\traceId ->
                  bindResult (decodeArray decodeAction "actions" trace) (\actions ->
                    Ok
                      { now: now
                      , windows: windows
                      , tabs: tabs
                      , traceId: traceId
                      , actions: actions
                      })))))))
    else Err (oracleError Nothing "unsupported-version" "Only oracle input version 1 is supported"))

decodeWindow :: Json -> Result RuntimeWindow
decodeWindow json =
  bindResult (requireInt "id" json) (\id ->
    bindResult (requireBoolean "focused" json) (\focused ->
      Ok
        { id: WindowId id
        , focused: focused
        , incognito: fieldBooleanDefault "incognito" false json
        , state: mapMaybe (\state -> Just (parseRuntimeWindowState state)) (fieldString "state" json)
        }))

decodeTab :: Json -> Result RuntimeTab
decodeTab json =
  bindResult (requireInt "id" json) (\id ->
    bindResult (requireInt "windowId" json) (\windowId ->
      bindResult (requireInt "index" json) (\index ->
        bindResult (requireBoolean "active" json) (\active ->
          Ok
            { id: TabId id
            , windowId: WindowId windowId
            , index: index
            , active: active
            , openerTabId: mapMaybe (\value -> Just (TabId value)) (fieldInt "openerTabId" json)
            , url: fieldString "url" json
            , title: fieldString "title" json
            , favIconUrl: fieldString "favIconUrl" json
            , incognito: fieldBooleanDefault "incognito" false json
            }))))

decodeAction :: Json -> Result Action
decodeAction json =
  bindResult (requireString "type" json) (\actionType ->
    if eqString actionType "openTab" then
      bindResult (decodeWindowSelectorField "window" json) (\window ->
        Ok (OpenTab
          { window: window
          , active: fieldBoolean "active" json
          , title: fieldString "title" json
          , url: fieldString "url" json
          , favIconUrl: fieldString "favIconUrl" json
          , openerTab: decodeOptionalTabSelectorField "openerTab" json
          , captureTab: fieldString "captureTab" json
          , staleQueryFromCapture: fieldString "staleQueryFromCapture" json
          }))
    else if eqString actionType "activateTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab -> Ok (ActivateTab tab))
    else if eqString actionType "updateTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab ->
        Ok (UpdateTab
          { tab: tab
          , title: fieldString "title" json
          , url: fieldString "url" json
          , favIconUrl: fieldString "favIconUrl" json
          }))
    else if eqString actionType "focusWindow" then
      bindResult (decodeWindowSelectorField "window" json) (\window -> Ok (FocusWindow window))
    else if eqString actionType "nativeSetWindowState" then
      bindResult (decodeWindowSelectorField "window" json) (\window ->
        bindResult (requireString "state" json) (\state -> Ok (NativeSetWindowState window (parseRuntimeWindowState state))))
    else if eqString actionType "nativeOpenWindow" then
      bindResult (decodeNativeOpenWindowTabs json) (\tabs ->
        Ok (NativeOpenWindow
          { tabs: tabs
          , focused: fieldBoolean "focused" json
          , captureWindow: fieldString "captureWindow" json
          , captureTabs: fieldString "captureTabs" json
          }))
    else if eqString actionType "nativeMoveTabToWindow" then
      bindResult (decodeTabSelectorField "tab" json) (\tab ->
        bindResult (decodeWindowSelectorField "window" json) (\window ->
          Ok (NativeMoveTabToWindow
            { tab: tab
            , window: window
            , index: fieldInt "index" json
            , active: fieldBoolean "active" json
            })))
    else if eqString actionType "nativeMoveTabToNewWindow" then
      bindResult (decodeTabSelectorField "tab" json) (\tab ->
        Ok (NativeMoveTabToNewWindow
          { tab: tab
          , active: fieldBoolean "active" json
          , captureWindow: fieldString "captureWindow" json
          }))
    else if eqString actionType "outlinerGroupTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab -> Ok (OutlinerGroupTab tab))
    else if eqString actionType "outlinerMoveTabToNewWindow" then
      bindResult (decodeTabSelectorField "tab" json) (\tab -> Ok (OutlinerMoveTabToNewWindow tab))
    else if eqString actionType "outlinerCloseTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab -> Ok (OutlinerCloseTab tab))
    else if eqString actionType "outlinerCloseWindow" then
      bindResult (decodeWindowSelectorField "window" json) (\window -> Ok (OutlinerCloseWindow window))
    else if eqString actionType "outlinerDeleteNode" then
      bindResult (decodeNodeSelectorField "node" json) (\node -> Ok (OutlinerDeleteNode node))
    else Ok (UnsupportedAction actionType))

decodeNativeOpenWindowTabs :: Json -> Result (Array NativeOpenWindowTab)
decodeNativeOpenWindowTabs json =
  decodeArray decodeNativeOpenWindowTab "tabs" json

decodeNativeOpenWindowTab :: Json -> Result NativeOpenWindowTab
decodeNativeOpenWindowTab json =
  Ok
    { active: fieldBoolean "active" json
    , title: fieldString "title" json
    , url: fieldString "url" json
    , favIconUrl: fieldString "favIconUrl" json
    , openerTab: decodeOptionalTabSelectorField "openerTab" json
    }

decodeTabSelectorField :: String -> Json -> Result TabSelector
decodeTabSelectorField key json =
  bindResult (requireObject key json) decodeTabSelector

decodeOptionalTabSelectorField :: String -> Json -> Maybe TabSelector
decodeOptionalTabSelectorField key json =
  case fieldObject key json of
    Nothing -> Nothing
    Just selectorJson ->
      case decodeTabSelector selectorJson of
        Err _ -> Nothing
        Ok selector -> Just selector

decodeTabSelector :: Json -> Result TabSelector
decodeTabSelector json =
  case fieldInt "tabId" json of
    Just id -> Ok (TabById (TabId id))
    Nothing ->
      case fieldString "capture" json of
        Just capture -> Ok (TabCapture capture)
        Nothing ->
          case fieldString "role" json of
            Just role -> Ok (TabRole role)
            Nothing ->
              case fieldObject "inWindow" json of
                Just windowJson ->
                  bindResult (decodeWindowSelector windowJson) (\window ->
                    Ok (TabInWindow window (fieldInt "index" json)))
                Nothing -> Err (oracleError Nothing "invalid-selector" "Invalid tab selector")

decodeWindowSelectorField :: String -> Json -> Result WindowSelector
decodeWindowSelectorField key json =
  bindResult (requireObject key json) decodeWindowSelector

decodeWindowSelector :: Json -> Result WindowSelector
decodeWindowSelector json =
  case fieldInt "windowId" json of
    Just id -> Ok (WindowById (WindowId id))
    Nothing ->
      case fieldString "capture" json of
        Just capture -> Ok (WindowCapture capture)
        Nothing ->
          case fieldString "role" json of
            Just role -> Ok (WindowRole role)
            Nothing -> Err (oracleError Nothing "invalid-selector" "Invalid window selector")

decodeNodeSelectorField :: String -> Json -> Result NodeSelector
decodeNodeSelectorField key json =
  bindResult (requireObject key json) decodeNodeSelector

decodeNodeSelector :: Json -> Result NodeSelector
decodeNodeSelector json =
  case fieldString "nodeId" json of
    Just id -> Ok (NodeById (NodeId id))
    Nothing ->
      case fieldObject "tab" json of
        Just tabJson -> bindResult (decodeTabSelector tabJson) (\tab -> Ok (NodeByTab tab))
        Nothing ->
          case fieldObject "window" json of
            Just windowJson -> bindResult (decodeWindowSelector windowJson) (\window -> Ok (NodeByWindow window))
            Nothing -> Err (oracleError Nothing "invalid-selector" "Invalid node selector")

runInput :: OracleInput -> Result (Array Snapshot)
runInput input =
  bindResult (initialModel input) (\model ->
    bindResult (runActions 0 input.actions model [snapshot model]) (\snapshots -> Ok snapshots))

initialModel :: OracleInput -> Result OracleModel
initialModel input =
  let
    windows = sortWindows input.windows
    tabs = sortTabs input.tabs
    outline = bootstrapOutline input.now windows tabs
  in
    Ok
      { now: input.now
      , nextTabId: maxInt 100 (addInt 1 (maxRuntimeTabId tabs))
      , nextWindowId: addInt 1 (maxRuntimeWindowId windows)
      , runtimeWindows: windows
      , runtimeTabs: tabs
      , outline: outline
      , tabCaptures: []
      , windowCaptures: []
      , lastOpenedTabId: Nothing
      , lastMovedTabId: Nothing
      , lastOpenedWindowId: Nothing
      }

runActions :: Int -> Array Action -> OracleModel -> Array Snapshot -> Result (Array Snapshot)
runActions step actions model snapshots =
  case indexArray step actions of
    Nothing -> Ok snapshots
    Just action ->
      case applyAction step action model of
        Err error -> Err error
        Ok nextModel -> runActions (addInt step 1) actions nextModel (snocArray snapshots (snapshot nextModel))

applyAction :: Int -> Action -> OracleModel -> Result OracleModel
applyAction step action model =
  case action of
    OpenTab details -> applyOpenTab step details model
    ActivateTab selector -> applyActivateTab step selector model
    UpdateTab details -> applyUpdateTab step details model
    FocusWindow selector -> applyFocusWindow step selector model
    NativeSetWindowState selector state -> applyNativeSetWindowState step selector state model
    NativeOpenWindow details -> applyNativeOpenWindow step details model
    NativeMoveTabToWindow details -> applyNativeMoveTabToWindow step details model
    NativeMoveTabToNewWindow details -> applyNativeMoveTabToNewWindow step details model
    OutlinerGroupTab selector -> applyOutlinerRelocation step selector true model
    OutlinerMoveTabToNewWindow selector -> applyOutlinerRelocation step selector false model
    OutlinerCloseTab selector -> applyOutlinerCloseTab step selector model
    OutlinerCloseWindow selector -> applyOutlinerCloseWindow step selector model
    OutlinerDeleteNode selector -> applyOutlinerDeleteNode step selector model
    UnsupportedAction actionType -> Err (oracleStepError step "unsupported-action" (appendString "Unsupported action: " actionType))

bootstrapOutline :: Int -> Array RuntimeWindow -> Array RuntimeTab -> Outline
bootstrapOutline now windows tabs =
  foldlArray (bootstrapWindow now tabs) { rootIds: [], nodes: [] } (filterArray (\window -> notBoolean window.incognito) windows)

bootstrapWindow :: Int -> Array RuntimeTab -> Outline -> RuntimeWindow -> Outline
bootstrapWindow now allTabs outline window =
  let
    windowId = windowNodeId window.id
    windowNode =
      { id: windowId
      , kind: WindowKind
      , status: LiveStatus
      , parentId: Nothing
      , childIds: []
      , title: "Group"
      , url: Nothing
      , favIconUrl: Nothing
      , active: Just window.focused
      , liveWindowId: Just window.id
      , liveTabId: Nothing
      , restoreSessionId: Nothing
      , restoreUrl: Nothing
      , restoreTitle: Nothing
      , restoreFavIconUrl: Nothing
      , runtimeProvenance: Nothing
      }
    tabs = tabsInWindowFrom allTabs window.id
    withWindow = { rootIds: snocArray outline.rootIds windowId, nodes: snocArray outline.nodes windowNode }
    withTabs = foldlArray (\current tab -> addNode current (tabToNode now windowId tab)) withWindow tabs
  in
    foldlArray (\current tab -> attachTabToBootstrapParent current windowId tabs tab) withTabs tabs

attachTabToBootstrapParent :: Outline -> NodeId -> Array RuntimeTab -> RuntimeTab -> Outline
attachTabToBootstrapParent outline fallbackWindowNodeId windowTabs tab =
  let
    nodeId = tabNodeId tab.id
    parentId = bootstrapParentForTab outline fallbackWindowNodeId windowTabs tab
  in
    appendChild parentId nodeId (replaceNode outline (setParent nodeId parentId outline))

bootstrapParentForTab :: Outline -> NodeId -> Array RuntimeTab -> RuntimeTab -> NodeId
bootstrapParentForTab outline fallbackWindowNodeId windowTabs tab =
  case tab.openerTabId of
    Nothing -> fallbackWindowNodeId
    Just openerTabId ->
      if isBlankRuntimeTabUrl tab.url then fallbackWindowNodeId
      else if anyArray (\candidate -> tabIdEq candidate.id openerTabId) windowTabs then
        let openerNodeId = tabNodeId openerTabId in
          case findNode openerNodeId outline of
            Nothing -> fallbackWindowNodeId
            Just _ -> openerNodeId
      else fallbackWindowNodeId

tabToNode :: Int -> NodeId -> RuntimeTab -> OutlineNode
tabToNode now parentId tab =
  { id: tabNodeId tab.id
  , kind: TabKind
  , status: LiveStatus
  , parentId: Nothing
  , childIds: []
  , title: runtimeTabTitle tab
  , url: tab.url
  , favIconUrl: tab.favIconUrl
  , active: Just tab.active
  , liveWindowId: Just tab.windowId
  , liveTabId: Just tab.id
  , restoreSessionId: Nothing
  , restoreUrl: Nothing
  , restoreTitle: Nothing
  , restoreFavIconUrl: Nothing
  , runtimeProvenance: Nothing
  }

applyOpenTab :: Int -> OpenTabAction -> OracleModel -> Result OracleModel
applyOpenTab step details model =
  case details.staleQueryFromCapture of
    Just _ -> Err (oracleStepError step "unsupported-action" "openTab staleQueryFromCapture is outside the v1 oracle slice")
    Nothing ->
      bindResult (resolveWindowSelector step details.window model) (\window ->
        bindResult (resolveMaybeTabSelector step details.openerTab model) (\opener ->
          let
            tabId = TabId model.nextTabId
            existingTabs = tabsInWindow model window.id
            active = maybe true identityBoolean details.active
            tab =
              { id: tabId
              , windowId: window.id
              , index: lengthArray existingTabs
              , active: active
              , openerTabId: mapMaybe (\value -> Just value.id) opener
              , url: maybe (Just (appendString "https://domain.example/" (intToString model.nextTabId))) Just details.url
              , title: maybe (Just (appendString "Domain " (intToString model.nextTabId))) Just details.title
              , favIconUrl: details.favIconUrl
              , incognito: false
              }
            runtimeTabs = createRuntimeTab model.runtimeTabs tab
            outline = addLiveTabToOutline model.outline model.now tab
            nextModel = setTabCapture details.captureTab tabId
              model
                { nextTabId = addInt model.nextTabId 1
                , runtimeTabs = runtimeTabs
                , outline = if active then setActiveTabInOutlineWindow tab.windowId tab.id outline else outline
                , lastOpenedTabId = Just tabId
                }
          in Ok nextModel))

applyActivateTab :: Int -> TabSelector -> OracleModel -> Result OracleModel
applyActivateTab step selector model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    Ok model
      { runtimeTabs = setRuntimeActiveTab tab.id tab.windowId model.runtimeTabs
      , outline = setActiveTabInOutlineWindow tab.windowId tab.id model.outline
      })

applyUpdateTab :: Int -> UpdateTabAction -> OracleModel -> Result OracleModel
applyUpdateTab step details model =
  bindResult (resolveTabSelector step details.tab model) (\tab ->
    let
      defaultTitle = appendString (maybe "Domain" identityString tab.title) " updated"
      titleChange = if hasNoTabMetadataChange details then Just defaultTitle else details.title
      updatedTab = tab
        { title = maybe tab.title Just titleChange
        , url = maybe tab.url Just details.url
        , favIconUrl = maybe tab.favIconUrl Just details.favIconUrl
        }
    in
      Ok model
        { runtimeTabs = replaceRuntimeTab updatedTab model.runtimeTabs
        , outline = updateLiveTabMetadata updatedTab model.outline
        })

applyFocusWindow :: Int -> WindowSelector -> OracleModel -> Result OracleModel
applyFocusWindow step selector model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    Ok model
      { runtimeWindows = mapArray (\candidate -> candidate { focused = windowIdEq candidate.id window.id }) model.runtimeWindows
      , outline = setActiveWindowInOutline window.id model.outline
      })

applyNativeSetWindowState :: Int -> WindowSelector -> RuntimeWindowState -> OracleModel -> Result OracleModel
applyNativeSetWindowState step selector state model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    Ok model
      { runtimeWindows = mapArray
          (\candidate -> if windowIdEq candidate.id window.id then candidate { state = Just state } else candidate)
          model.runtimeWindows
      })

applyNativeOpenWindow :: Int -> NativeOpenWindowAction -> OracleModel -> Result OracleModel
applyNativeOpenWindow step details model =
  bindResult (decodeNativeOpenWindowRuntimeTabs step details model) (\createdTabs ->
    let
      windowId = WindowId model.nextWindowId
      focused = maybe true identityBoolean details.focused
      window = { id: windowId, focused: focused, incognito: false, state: Nothing }
      runtimeWindows = snocArray
        (if focused then mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows else model.runtimeWindows)
        window
      runtimeTabs = appendArray model.runtimeTabs createdTabs
      outlineWithWindow = addLiveWindowToOutline model.outline model.now window (Just "browserCreated")
      outlineWithTabs = foldlArray (\outline tab -> addLiveTabToOutline outline model.now tab) outlineWithWindow createdTabs
      outline = if focused then setActiveWindowInOutline windowId outlineWithTabs else outlineWithTabs
      firstTabId = case indexArray 0 createdTabs of
        Nothing -> model.lastOpenedTabId
        Just tab -> Just tab.id
      nextTabId = addInt model.nextTabId (lengthArray createdTabs)
      nextModel = setWindowCapture details.captureWindow windowId
        (setTabsCapture details.captureTabs createdTabs
          model
            { nextTabId = nextTabId
            , nextWindowId = addInt model.nextWindowId 1
            , runtimeWindows = runtimeWindows
            , runtimeTabs = reindexAllRuntimeTabs runtimeTabs
            , outline = outline
            , lastOpenedWindowId = Just windowId
            , lastOpenedTabId = firstTabId
            })
    in Ok nextModel)

decodeNativeOpenWindowRuntimeTabs :: Int -> NativeOpenWindowAction -> OracleModel -> Result (Array RuntimeTab)
decodeNativeOpenWindowRuntimeTabs step details model =
  bindResult (nativeOpenWindowTabSpecs step details.tabs model) (\specs ->
    let
      windowId = WindowId model.nextWindowId
      activeIndex = activeIndexForNativeOpenWindow specs
    in Ok (mapWithIndexArray (\index spec ->
      { id: TabId (addInt model.nextTabId index)
      , windowId: windowId
      , index: index
      , active: eqInt index activeIndex
      , openerTabId: spec.openerTabId
      , url: maybe (Just (appendString "https://native.example/" (intToString (addInt model.nextTabId index)))) Just spec.url
      , title: maybe (Just (appendString "Native " (intToString (addInt model.nextTabId index)))) Just spec.title
      , favIconUrl: spec.favIconUrl
      , incognito: false
      }) specs))

type NativeOpenWindowTabSpec =
  { active :: Maybe Boolean
  , title :: Maybe String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , openerTabId :: Maybe TabId
  }

nativeOpenWindowTabSpecs :: Int -> Array NativeOpenWindowTab -> OracleModel -> Result (Array NativeOpenWindowTabSpec)
nativeOpenWindowTabSpecs step tabs model =
  decodeItemsWithIndex (\_ tab ->
    bindResult (resolveMaybeTabSelector step tab.openerTab model) (\opener ->
      Ok
        { active: tab.active
        , title: tab.title
        , url: tab.url
        , favIconUrl: tab.favIconUrl
        , openerTabId: mapMaybe (\value -> Just value.id) opener
        })) tabs

activeIndexForNativeOpenWindow :: Array NativeOpenWindowTabSpec -> Int
activeIndexForNativeOpenWindow tabs =
  case findIndexArray (\tab -> maybe false identityBoolean tab.active) tabs of
    Nothing -> 0
    Just index -> maxInt 0 index

applyNativeMoveTabToWindow :: Int -> NativeMoveTabAction -> OracleModel -> Result OracleModel
applyNativeMoveTabToWindow step details model =
  bindResult (resolveTabSelector step details.tab model) (\tab ->
    bindResult (resolveWindowSelector step details.window model) (\window ->
      moveRuntimeTabAndOutline step tab window.id details.index details.active false Nothing model))

applyNativeMoveTabToNewWindow :: Int -> NativeMoveTabToNewWindowAction -> OracleModel -> Result OracleModel
applyNativeMoveTabToNewWindow step details model =
  bindResult (resolveTabSelector step details.tab model) (\tab ->
    let
      windowId = WindowId model.nextWindowId
      focused = maybe true identityBoolean details.active
      window = { id: windowId, focused: focused, incognito: false, state: Nothing }
      runtimeWindows = snocArray
        (if focused then mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows else model.runtimeWindows)
        window
      outline = addLiveWindowToOutline model.outline model.now window (Just "browserCreated")
      withWindow = setWindowCapture details.captureWindow windowId
        model
          { nextWindowId = addInt model.nextWindowId 1
          , runtimeWindows = runtimeWindows
          , outline = if focused then setActiveWindowInOutline windowId outline else outline
          , lastOpenedWindowId = Just windowId
          }
    in moveRuntimeTabAndOutline step tab windowId (Just 0) (Just focused) false Nothing withWindow)

applyOutlinerRelocation :: Int -> TabSelector -> Boolean -> OracleModel -> Result OracleModel
applyOutlinerRelocation step selector wrap model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    let
      windowId = WindowId model.nextWindowId
      window = { id: windowId, focused: true, incognito: false, state: Nothing }
      runtimeWindows = snocArray (mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows) window
      withWindow =
        model
          { nextWindowId = addInt model.nextWindowId 1
          , runtimeWindows = runtimeWindows
          , lastOpenedWindowId = Just windowId
          }
    in
      bindResult (moveRuntimeTabAndOutline step tab windowId (Just 0) (Just tab.active) true (Just wrap) withWindow)
        (\moved -> Ok moved { lastMovedTabId = Just tab.id }))

moveRuntimeTabAndOutline ::
  Int ->
  RuntimeTab ->
  WindowId ->
  Maybe Int ->
  Maybe Boolean ->
  Boolean ->
  Maybe Boolean ->
  OracleModel ->
  Result OracleModel
moveRuntimeTabAndOutline step tab targetWindowId index active commandCreated wrapMode model =
  let
    targetIndex = maybe (lengthArray (tabsInWindow model targetWindowId)) identityInt index
    activeValue = maybe tab.active identityBoolean active
    movedRuntimeTabs = moveRuntimeTab tab.id targetWindowId targetIndex model.runtimeTabs
    activeRuntimeTabs = applyNativeMoveActiveState tab.id tab.windowId targetWindowId activeValue movedRuntimeTabs
    runtimeTabs = reindexAllRuntimeTabs activeRuntimeTabs
    runtimeWindows = removeEmptyRuntimeWindows runtimeTabs model.runtimeWindows
    outlineWithCommandWindow = case wrapMode of
      Nothing -> if commandCreated then addLiveWindowToOutline model.outline model.now (runtimeWindowForId targetWindowId runtimeWindows) (Just "commandCreated") else model.outline
      Just true -> model.outline
      Just false -> model.outline
    outline = case wrapMode of
      Just true -> wrapLiveTabInCommandWindow tab.id targetWindowId model.now outlineWithCommandWindow
      Just false -> moveLiveTabToNewRootWindow tab.id targetWindowId model.now outlineWithCommandWindow
      Nothing -> moveLiveTabToWindow tab.id targetWindowId model.now outlineWithCommandWindow
  in
    Ok model
      { runtimeTabs = runtimeTabs
      , runtimeWindows = runtimeWindows
      , outline = closeOutlineWindowsMissingFromRuntime runtimeWindows (setActiveWindowInOutlineIfFocused runtimeWindows (updateLiveTabWindowRefForSubtree tab.id targetWindowId outline))
      , lastMovedTabId = Just tab.id
      , lastOpenedWindowId = Just targetWindowId
      }

applyOutlinerCloseTab :: Int -> TabSelector -> OracleModel -> Result OracleModel
applyOutlinerCloseTab step selector model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    Ok model
      { runtimeTabs = reindexAllRuntimeTabs (filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) model.runtimeTabs)
      , runtimeWindows = removeEmptyRuntimeWindows (filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) model.runtimeTabs) model.runtimeWindows
      , outline = markClosedNodeById (tabNodeId tab.id) model.now model.outline
      })

applyOutlinerCloseWindow :: Int -> WindowSelector -> OracleModel -> Result OracleModel
applyOutlinerCloseWindow step selector model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    Ok model
      { runtimeTabs = filterArray (\tab -> notBoolean (windowIdEq tab.windowId window.id)) model.runtimeTabs
      , runtimeWindows = filterArray (\candidate -> notBoolean (windowIdEq candidate.id window.id)) model.runtimeWindows
      , outline = markClosedSubtreeById (windowNodeId window.id) model.now model.outline
      })

applyOutlinerDeleteNode :: Int -> NodeSelector -> OracleModel -> Result OracleModel
applyOutlinerDeleteNode step selector model =
  bindResult (resolveNodeSelector step selector model) (\node ->
    let
      subtreeIds = subtreeNodeIds node.id model.outline
      liveTabIds = liveTabIdsForNodes subtreeIds model.outline
      liveWindowIds = liveWindowIdsForNodes subtreeIds model.outline
      runtimeTabs = filterArray
        (\tab -> andBoolean
          (notBoolean (anyArray (\id -> tabIdEq id tab.id) liveTabIds))
          (notBoolean (anyArray (\id -> windowIdEq id tab.windowId) liveWindowIds)))
        model.runtimeTabs
      runtimeWindows = removeEmptyRuntimeWindows runtimeTabs (filterArray (\window -> notBoolean (anyArray (\id -> windowIdEq id window.id) liveWindowIds)) model.runtimeWindows)
      outline = deleteNodes subtreeIds model.outline
    in
      Ok model
        { runtimeTabs = reindexAllRuntimeTabs runtimeTabs
        , runtimeWindows = runtimeWindows
        , outline = outline
        })

addLiveWindowToOutline :: Outline -> Int -> RuntimeWindow -> Maybe String -> Outline
addLiveWindowToOutline outline now window provenance =
  let
    id = windowNodeId window.id
  in
    case findNode id outline of
      Just _ -> outline
      Nothing ->
        addNode
          { rootIds: snocArray outline.rootIds id, nodes: outline.nodes }
          { id: id
          , kind: WindowKind
          , status: LiveStatus
          , parentId: Nothing
          , childIds: []
          , title: "Group"
          , url: Nothing
          , favIconUrl: Nothing
          , active: Just window.focused
          , liveWindowId: Just window.id
          , liveTabId: Nothing
          , restoreSessionId: Nothing
          , restoreUrl: Nothing
          , restoreTitle: Nothing
          , restoreFavIconUrl: Nothing
          , runtimeProvenance: provenance
          }

addLiveTabToOutline :: Outline -> Int -> RuntimeTab -> Outline
addLiveTabToOutline outline now tab =
  let
    parentId = parentForNewRuntimeTab outline tab
    nodeId = tabNodeId tab.id
    node = (tabToNode now parentId tab) { parentId = Just parentId }
  in
    appendChild parentId nodeId (addNode outline node)

parentForNewRuntimeTab :: Outline -> RuntimeTab -> NodeId
parentForNewRuntimeTab outline tab =
  case tab.openerTabId of
    Just openerId ->
      if isBlankRuntimeTabUrl tab.url then windowNodeId tab.windowId
      else
        let openerNodeId = tabNodeId openerId in
          case findNode openerNodeId outline of
            Just openerNode ->
              case openerNode.liveWindowId of
                Just openerWindowId -> if windowIdEq openerWindowId tab.windowId then openerNodeId else windowNodeId tab.windowId
                Nothing -> windowNodeId tab.windowId
            Nothing -> windowNodeId tab.windowId
    Nothing -> windowNodeId tab.windowId

wrapLiveTabInCommandWindow :: TabId -> WindowId -> Int -> Outline -> Outline
wrapLiveTabInCommandWindow tabId newWindowId now outline =
  let
    tabNode = tabNodeId tabId
    wrapperId = windowNodeId newWindowId
  in
    case findNode tabNode outline of
      Nothing -> outline
      Just node ->
        let
          wrapper =
            { id: wrapperId
            , kind: WindowKind
            , status: LiveStatus
            , parentId: node.parentId
            , childIds: [tabNode]
            , title: "Group"
            , url: Nothing
            , favIconUrl: Nothing
            , active: Just true
            , liveWindowId: Just newWindowId
            , liveTabId: Nothing
            , restoreSessionId: Nothing
            , restoreUrl: Nothing
            , restoreTitle: Nothing
            , restoreFavIconUrl: Nothing
            , runtimeProvenance: Just "commandCreated"
            }
          detached = detachNode tabNode outline
          withWrapper = insertNodeWhereNodeWas node.id wrapper detached
          withTab = replaceNode withWrapper (node { parentId = Just wrapperId })
        in setActiveWindowInOutline newWindowId withTab

moveLiveTabToNewRootWindow :: TabId -> WindowId -> Int -> Outline -> Outline
moveLiveTabToNewRootWindow tabId newWindowId now outline =
  let
    tabNode = tabNodeId tabId
    windowNode =
      { id: windowNodeId newWindowId
      , kind: WindowKind
      , status: LiveStatus
      , parentId: Nothing
      , childIds: [tabNode]
      , title: "Group"
      , url: Nothing
      , favIconUrl: Nothing
      , active: Just true
      , liveWindowId: Just newWindowId
      , liveTabId: Nothing
      , restoreSessionId: Nothing
      , restoreUrl: Nothing
      , restoreTitle: Nothing
      , restoreFavIconUrl: Nothing
      , runtimeProvenance: Just "commandCreated"
      }
    detached = detachNode tabNode outline
    withWindow = { rootIds: [windowNode.id], nodes: snocArray detached.nodes windowNode }
    withRoots = withWindow { rootIds = appendArray withWindow.rootIds detached.rootIds }
  in
    replaceNode withRoots ((requireNodeOr tabNode outline (emptyTabNode tabNode)) { parentId = Just windowNode.id })

moveLiveTabToWindow :: TabId -> WindowId -> Int -> Outline -> Outline
moveLiveTabToWindow tabId targetWindowId now outline =
  let
    tabNode = tabNodeId tabId
    targetWindowNode = windowNodeId targetWindowId
  in
    case findNode tabNode outline of
      Nothing -> outline
      Just node ->
        let
          detached = detachNode tabNode outline
          updated = node { parentId = Just targetWindowNode }
        in appendChild targetWindowNode tabNode (replaceNode detached updated)

updateLiveTabWindowRefForSubtree :: TabId -> WindowId -> Outline -> Outline
updateLiveTabWindowRefForSubtree tabId windowId outline =
  let ids = subtreeNodeIds (tabNodeId tabId) outline in
    outline { nodes = mapArray (\node ->
      if andBoolean (anyArray (\id -> nodeIdEq id node.id) ids) (isLiveTabNode node) then node { liveWindowId = Just windowId }
      else node) outline.nodes }

markClosedNodeById :: NodeId -> Int -> Outline -> Outline
markClosedNodeById nodeId now outline =
  replaceNode outline (markClosed (requireNodeOr nodeId outline (emptyTabNode nodeId)))

markClosedSubtreeById :: NodeId -> Int -> Outline -> Outline
markClosedSubtreeById nodeId now outline =
  let ids = subtreeNodeIds nodeId outline in
    outline { nodes = mapArray (\node -> if anyArray (\id -> nodeIdEq id node.id) ids then markClosed node else node) outline.nodes }

markClosed :: OutlineNode -> OutlineNode
markClosed node =
  node
    { status = ClosedStatus
    , active = Nothing
    , liveWindowId = Nothing
    , liveTabId = Nothing
    , restoreUrl = node.url
    , restoreTitle = Just node.title
    , restoreFavIconUrl = node.favIconUrl
    }

deleteNodes :: Array NodeId -> Outline -> Outline
deleteNodes ids outline =
  let
    nodes = filterArray (\node -> notBoolean (anyArray (\id -> nodeIdEq id node.id) ids)) outline.nodes
    rootIds = filterArray (\id -> notBoolean (anyArray (\deletedId -> nodeIdEq deletedId id) ids)) outline.rootIds
    cleaned = { rootIds: rootIds, nodes: nodes }
  in
    cleaned { nodes = mapArray (\node -> node { childIds = filterArray (\childId -> notBoolean (anyArray (\id -> nodeIdEq id childId) ids)) node.childIds }) cleaned.nodes }

closeOutlineWindowsMissingFromRuntime :: Array RuntimeWindow -> Outline -> Outline
closeOutlineWindowsMissingFromRuntime runtimeWindows outline =
  foldlArray (\current node ->
    case node.liveWindowId of
      Just windowId ->
        if andBoolean (isLiveWindowNode node) (notBoolean (anyArray (\window -> windowIdEq window.id windowId) runtimeWindows)) then
          markClosedSubtreeById node.id 0 current
        else current
      Nothing -> current) outline outline.nodes

snapshot :: OracleModel -> Snapshot
snapshot model =
  { outline:
      { rootIds: mapArray nodeIdString model.outline.rootIds
      , nodes: sortNodes (mapArray snapshotNode model.outline.nodes)
      }
  , runtime:
      { windows: mapArray (snapshotRuntimeWindow model) (sortWindows model.runtimeWindows)
      , tabs: mapArray snapshotRuntimeTab (sortTabs model.runtimeTabs)
      }
  }

snapshotNode :: OutlineNode -> SnapshotNode
snapshotNode node =
  { id: nodeIdString node.id
  , kind: nodeKindString node.kind
  , status: nodeStatusString node.status
  , parentId: mapMaybe (\id -> Just (nodeIdString id)) node.parentId
  , childIds: mapArray nodeIdString node.childIds
  , title: node.title
  , url: node.url
  , favIconUrl: node.favIconUrl
  , active: node.active
  , live:
      { windowId: mapMaybe (\id -> Just (windowIdInt id)) node.liveWindowId
      , tabId: mapMaybe (\id -> Just (tabIdInt id)) node.liveTabId
      }
  , restore:
      { sessionId: node.restoreSessionId
      , url: node.restoreUrl
      , title: node.restoreTitle
      , favIconUrl: node.restoreFavIconUrl
      }
  , runtimeProvenance: node.runtimeProvenance
  }

snapshotRuntimeWindow :: OracleModel -> RuntimeWindow -> SnapshotRuntimeWindow
snapshotRuntimeWindow model window =
  { id: windowIdInt window.id
  , focused: window.focused
  , incognito: window.incognito
  , state: mapMaybe (\state -> Just (windowStateString state)) window.state
  , tabIds: mapArray (\tab -> tabIdInt tab.id) (tabsInWindow model window.id)
  }

snapshotRuntimeTab :: RuntimeTab -> SnapshotRuntimeTab
snapshotRuntimeTab tab =
  { id: tabIdInt tab.id
  , windowId: windowIdInt tab.windowId
  , index: tab.index
  , active: tab.active
  , openerTabId: mapMaybe (\id -> Just (tabIdInt id)) tab.openerTabId
  , url: tab.url
  , title: tab.title
  , favIconUrl: tab.favIconUrl
  , incognito: tab.incognito
  }

resolveMaybeTabSelector :: Int -> Maybe TabSelector -> OracleModel -> Result (Maybe RuntimeTab)
resolveMaybeTabSelector step maybeSelector model =
  case maybeSelector of
    Nothing -> Ok Nothing
    Just selector -> bindResult (resolveTabSelector step selector model) (\tab -> Ok (Just tab))

resolveTabSelector :: Int -> TabSelector -> OracleModel -> Result RuntimeTab
resolveTabSelector step selector model =
  case selector of
    TabById id -> requireRuntimeTab step id model
    TabCapture name ->
      case findPair name model.tabCaptures of
        Nothing -> Err (oracleStepError step "missing-capture" (appendString "Missing tab capture: " name))
        Just tabId -> requireRuntimeTab step tabId model
    TabRole role ->
      if eqString role "activeTab" then
        case findArray (\tab -> tab.active) model.runtimeTabs of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Missing active runtime tab")
          Just tab -> Ok tab
      else if eqString role "lastOpenedTab" then
        case model.lastOpenedTabId of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Missing last opened tab")
          Just id -> requireRuntimeTab step id model
      else if eqString role "lastMovedTab" then
        case model.lastMovedTabId of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Missing last moved tab")
          Just id -> requireRuntimeTab step id model
      else
        case indexArray 0 (sortTabs model.runtimeTabs) of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Missing first runtime tab")
          Just tab -> Ok tab
    TabInWindow windowSelector maybeIndex ->
      bindResult (resolveWindowSelector step windowSelector model) (\window ->
        case indexArray (maybe 0 identityInt maybeIndex) (tabsInWindow model window.id) of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Missing tab in selected window")
          Just tab -> Ok tab)

resolveWindowSelector :: Int -> WindowSelector -> OracleModel -> Result RuntimeWindow
resolveWindowSelector step selector model =
  case selector of
    WindowById id -> requireRuntimeWindow step id model
    WindowCapture name ->
      case findPair name model.windowCaptures of
        Nothing -> Err (oracleStepError step "missing-capture" (appendString "Missing window capture: " name))
        Just windowId -> requireRuntimeWindow step windowId model
    WindowRole role ->
      if eqString role "focusedWindow" then
        case findArray (\window -> window.focused) model.runtimeWindows of
          Nothing -> Err (oracleStepError step "missing-runtime-window" "Missing focused runtime window")
          Just window -> Ok window
      else if eqString role "lastOpenedWindow" then
        case model.lastOpenedWindowId of
          Nothing -> Err (oracleStepError step "missing-runtime-window" "Missing last opened window")
          Just id -> requireRuntimeWindow step id model
      else
        case indexArray 0 (sortWindows model.runtimeWindows) of
          Nothing -> Err (oracleStepError step "missing-runtime-window" "Missing first runtime window")
          Just window -> Ok window

resolveNodeSelector :: Int -> NodeSelector -> OracleModel -> Result OutlineNode
resolveNodeSelector step selector model =
  case selector of
    NodeById id -> requireOutlineNode step id model.outline
    NodeByTab tabSelector ->
      bindResult (resolveTabSelector step tabSelector model) (\tab -> requireOutlineNode step (tabNodeId tab.id) model.outline)
    NodeByWindow windowSelector ->
      bindResult (resolveWindowSelector step windowSelector model) (\window -> requireOutlineNode step (windowNodeId window.id) model.outline)

requireRuntimeTab :: Int -> TabId -> OracleModel -> Result RuntimeTab
requireRuntimeTab step tabId model =
  case findArray (\tab -> tabIdEq tab.id tabId) model.runtimeTabs of
    Nothing -> Err (oracleStepError step "missing-runtime-tab" (appendString "Missing runtime tab " (intToString (tabIdInt tabId))))
    Just tab -> Ok tab

requireRuntimeWindow :: Int -> WindowId -> OracleModel -> Result RuntimeWindow
requireRuntimeWindow step windowId model =
  case findArray (\window -> windowIdEq window.id windowId) model.runtimeWindows of
    Nothing -> Err (oracleStepError step "missing-runtime-window" (appendString "Missing runtime window " (intToString (windowIdInt windowId))))
    Just window -> Ok window

requireOutlineNode :: Int -> NodeId -> Outline -> Result OutlineNode
requireOutlineNode step nodeId outline =
  case findNode nodeId outline of
    Nothing -> Err (oracleStepError step "missing-outline-node" (appendString "Missing outline node " (nodeIdString nodeId)))
    Just node -> Ok node

createRuntimeTab :: Array RuntimeTab -> RuntimeTab -> Array RuntimeTab
createRuntimeTab tabs tab =
  reindexAllRuntimeTabs (snocArray (mapArray (\candidate ->
    if andBoolean (windowIdEq candidate.windowId tab.windowId) tab.active then candidate { active = false }
    else candidate) tabs) tab)

setRuntimeActiveTab :: TabId -> WindowId -> Array RuntimeTab -> Array RuntimeTab
setRuntimeActiveTab tabId windowId tabs =
  mapArray (\tab -> if windowIdEq tab.windowId windowId then tab { active = tabIdEq tab.id tabId } else tab) tabs

replaceRuntimeTab :: RuntimeTab -> Array RuntimeTab -> Array RuntimeTab
replaceRuntimeTab updated tabs =
  mapArray (\tab -> if tabIdEq tab.id updated.id then updated else tab) tabs

moveRuntimeTab :: TabId -> WindowId -> Int -> Array RuntimeTab -> Array RuntimeTab
moveRuntimeTab tabId targetWindowId targetIndex tabs =
  case findArray (\tab -> tabIdEq tab.id tabId) tabs of
    Nothing -> tabs
    Just moving ->
      let
        remaining = filterArray (\tab -> notBoolean (tabIdEq tab.id tabId)) tabs
        targetTabs = tabsInWindowFrom remaining targetWindowId
        boundedIndex = maxInt 0 (minInt targetIndex (lengthArray targetTabs))
        moved = moving { windowId = targetWindowId, index = boundedIndex }
      in insertRuntimeTabAt remaining moved targetWindowId boundedIndex

insertRuntimeTabAt :: Array RuntimeTab -> RuntimeTab -> WindowId -> Int -> Array RuntimeTab
insertRuntimeTabAt tabs moved targetWindowId targetIndex =
  mapWithIndexArray (\_ tab -> tab)
    (appendArray
      (filterArray (\tab -> notBoolean (windowIdEq tab.windowId targetWindowId)) tabs)
      (insertAtIndex moved targetIndex (tabsInWindowFrom tabs targetWindowId)))

insertAtIndex :: RuntimeTab -> Int -> Array RuntimeTab -> Array RuntimeTab
insertAtIndex value targetIndex values =
  let
    inserted = foldlWithIndexArray (\index acc item -> if eqInt index targetIndex then snocArray (snocArray acc value) item else snocArray acc item) [] values
  in
    snocIfEnd value targetIndex values inserted

foreign import minInt :: Int -> Int -> Int
foreign import mapWithIndexArray :: forall a b. (Int -> a -> b) -> Array a -> Array b
foreign import foldlWithIndexArray :: forall a b. (Int -> b -> a -> b) -> b -> Array a -> b
foreign import snocIfEnd :: forall a. a -> Int -> Array a -> Array a -> Array a

applyNativeMoveActiveState :: TabId -> WindowId -> WindowId -> Boolean -> Array RuntimeTab -> Array RuntimeTab
applyNativeMoveActiveState movedTabId sourceWindowId destinationWindowId active tabs =
  ensureWindowHasActiveTab destinationWindowId
    (ensureWindowHasActiveTab sourceWindowId
      (mapArray (\tab ->
        if tabIdEq tab.id movedTabId then tab { active = active }
        else if andBoolean active (windowIdEq tab.windowId destinationWindowId) then tab { active = false }
        else tab) tabs))

ensureWindowHasActiveTab :: WindowId -> Array RuntimeTab -> Array RuntimeTab
ensureWindowHasActiveTab windowId tabs =
  let windowTabs = tabsInWindowFrom tabs windowId in
    if orBoolean (eqInt (lengthArray windowTabs) 0) (anyArray (\tab -> tab.active) windowTabs) then tabs
    else
      case indexArray 0 windowTabs of
        Nothing -> tabs
        Just first -> mapArray (\tab -> if windowIdEq tab.windowId windowId then tab { active = tabIdEq tab.id first.id } else tab) tabs

reindexAllRuntimeTabs :: Array RuntimeTab -> Array RuntimeTab
reindexAllRuntimeTabs tabs =
  foldlArray (\current windowId -> reindexWindowTabs windowId current) tabs (runtimeWindowIdsFromTabs tabs)

reindexWindowTabs :: WindowId -> Array RuntimeTab -> Array RuntimeTab
reindexWindowTabs windowId tabs =
  let
    windowTabs = tabsInWindowFrom tabs windowId
    reindexed = mapWithIndexArray (\index tab -> tab { index = index }) windowTabs
  in
    appendArray
      (filterArray (\tab -> notBoolean (windowIdEq tab.windowId windowId)) tabs)
      reindexed

removeEmptyRuntimeWindows :: Array RuntimeTab -> Array RuntimeWindow -> Array RuntimeWindow
removeEmptyRuntimeWindows tabs windows =
  filterArray (\window -> anyArray (\tab -> windowIdEq tab.windowId window.id) tabs) windows

setActiveTabInOutlineWindow :: WindowId -> TabId -> Outline -> Outline
setActiveTabInOutlineWindow windowId tabId outline =
  outline { nodes = mapArray (\node ->
    if isLiveTabNode node then
      case node.liveWindowId of
        Just liveWindowId -> if windowIdEq liveWindowId windowId then node { active = Just (maybe false (\liveTabId -> tabIdEq liveTabId tabId) node.liveTabId) } else node
        Nothing -> node
    else node) outline.nodes }

setActiveWindowInOutline :: WindowId -> Outline -> Outline
setActiveWindowInOutline windowId outline =
  outline { nodes = mapArray (\node ->
    if isLiveWindowNode node then
      case node.liveWindowId of
        Just liveWindowId -> node { active = Just (windowIdEq liveWindowId windowId) }
        Nothing -> node
    else node) outline.nodes }

setActiveWindowInOutlineIfFocused :: Array RuntimeWindow -> Outline -> Outline
setActiveWindowInOutlineIfFocused windows outline =
  case findArray (\window -> window.focused) windows of
    Nothing -> outline
    Just window -> setActiveWindowInOutline window.id outline

updateLiveTabMetadata :: RuntimeTab -> Outline -> Outline
updateLiveTabMetadata tab outline =
  replaceNode outline
    ((requireNodeOr (tabNodeId tab.id) outline (emptyTabNode (tabNodeId tab.id)))
      { title = runtimeTabTitle tab
      , url = tab.url
      , favIconUrl = tab.favIconUrl
      , active = Just tab.active
      , liveWindowId = Just tab.windowId
      })

addNode :: Outline -> OutlineNode -> Outline
addNode outline node =
  outline { nodes = snocArray outline.nodes node }

replaceNode :: Outline -> OutlineNode -> Outline
replaceNode outline node =
  outline { nodes = mapArray (\candidate -> if nodeIdEq candidate.id node.id then node else candidate) outline.nodes }

setParent :: NodeId -> NodeId -> Outline -> OutlineNode
setParent nodeId parentId outline =
  (requireNodeOr nodeId outline (emptyTabNode nodeId)) { parentId = Just parentId }

appendChild :: NodeId -> NodeId -> Outline -> Outline
appendChild parentId childId outline =
  replaceNode outline ((requireNodeOr parentId outline (emptyTabNode parentId)) { childIds = snocArray (removeNodeId childId (requireNodeOr parentId outline (emptyTabNode parentId)).childIds) childId })

detachNode :: NodeId -> Outline -> Outline
detachNode nodeId outline =
  let withoutChild = outline { rootIds = removeNodeId nodeId outline.rootIds, nodes = mapArray (\node -> node { childIds = removeNodeId nodeId node.childIds }) outline.nodes } in
    case findNode nodeId withoutChild of
      Nothing -> withoutChild
      Just node -> replaceNode withoutChild (node { parentId = Nothing })

insertNodeWhereNodeWas :: NodeId -> OutlineNode -> Outline -> Outline
insertNodeWhereNodeWas originalId node outline =
  case node.parentId of
    Nothing ->
      { rootIds: replaceNodeId originalId node.id outline.rootIds
      , nodes: snocArray outline.nodes node
      }
    Just parentId ->
      let withNode = snocArray outline.nodes node in
        replaceNode
          { rootIds: outline.rootIds, nodes: withNode }
          ((requireNodeOr parentId outline (emptyTabNode parentId)) { childIds = replaceNodeId originalId node.id (requireNodeOr parentId outline (emptyTabNode parentId)).childIds })

findNode :: NodeId -> Outline -> Maybe OutlineNode
findNode nodeId outline =
  findArray (\node -> nodeIdEq node.id nodeId) outline.nodes

requireNodeOr :: NodeId -> Outline -> OutlineNode -> OutlineNode
requireNodeOr nodeId outline fallback =
  case findNode nodeId outline of
    Nothing -> fallback
    Just node -> node

emptyTabNode :: NodeId -> OutlineNode
emptyTabNode nodeId =
  { id: nodeId
  , kind: TabKind
  , status: NeutralStatus
  , parentId: Nothing
  , childIds: []
  , title: ""
  , url: Nothing
  , favIconUrl: Nothing
  , active: Nothing
  , liveWindowId: Nothing
  , liveTabId: Nothing
  , restoreSessionId: Nothing
  , restoreUrl: Nothing
  , restoreTitle: Nothing
  , restoreFavIconUrl: Nothing
  , runtimeProvenance: Nothing
  }

subtreeNodeIds :: NodeId -> Outline -> Array NodeId
subtreeNodeIds nodeId outline =
  case findNode nodeId outline of
    Nothing -> []
    Just node -> foldlArray (\ids childId -> appendArray ids (subtreeNodeIds childId outline)) [node.id] node.childIds

liveTabIdsForNodes :: Array NodeId -> Outline -> Array TabId
liveTabIdsForNodes nodeIds outline =
  mapMaybeArray (\nodeId ->
    case findNode nodeId outline of
      Just node -> if isLiveTabNode node then node.liveTabId else Nothing
      Nothing -> Nothing) nodeIds

liveWindowIdsForNodes :: Array NodeId -> Outline -> Array WindowId
liveWindowIdsForNodes nodeIds outline =
  mapMaybeArray (\nodeId ->
    case findNode nodeId outline of
      Just node -> if isLiveWindowNode node then node.liveWindowId else Nothing
      Nothing -> Nothing) nodeIds

tabsInWindow :: OracleModel -> WindowId -> Array RuntimeTab
tabsInWindow model windowId =
  tabsInWindowFrom model.runtimeTabs windowId

tabsInWindowFrom :: Array RuntimeTab -> WindowId -> Array RuntimeTab
tabsInWindowFrom tabs windowId =
  sortTabs (filterArray (\tab -> windowIdEq tab.windowId windowId) tabs)

runtimeWindowIdsFromTabs :: Array RuntimeTab -> Array WindowId
runtimeWindowIdsFromTabs tabs =
  foldlArray (\ids tab -> if anyArray (\id -> windowIdEq id tab.windowId) ids then ids else snocArray ids tab.windowId) [] tabs

runtimeWindowForId :: WindowId -> Array RuntimeWindow -> RuntimeWindow
runtimeWindowForId windowId windows =
  case findArray (\window -> windowIdEq window.id windowId) windows of
    Just window -> window
    Nothing -> { id: windowId, focused: false, incognito: false, state: Nothing }

maxRuntimeTabId :: Array RuntimeTab -> Int
maxRuntimeTabId tabs =
  foldlArray (\maxId tab -> maxInt maxId (tabIdInt tab.id)) 0 tabs

maxRuntimeWindowId :: Array RuntimeWindow -> Int
maxRuntimeWindowId windows =
  foldlArray (\maxId window -> maxInt maxId (windowIdInt window.id)) 0 windows

setTabCapture :: Maybe String -> TabId -> OracleModel -> OracleModel
setTabCapture maybeName tabId model =
  case maybeName of
    Nothing -> model
    Just name -> model { tabCaptures = setPair name tabId model.tabCaptures }

setTabsCapture :: Maybe String -> Array RuntimeTab -> OracleModel -> OracleModel
setTabsCapture maybeName tabs model =
  case maybeName of
    Nothing -> model
    Just name ->
      case indexArray 0 tabs of
        Nothing -> model
        Just tab -> model { tabCaptures = setPair name tab.id model.tabCaptures }

setWindowCapture :: Maybe String -> WindowId -> OracleModel -> OracleModel
setWindowCapture maybeName windowId model =
  case maybeName of
    Nothing -> model
    Just name -> model { windowCaptures = setPair name windowId model.windowCaptures }

findPair :: forall a. String -> Array (Pair String a) -> Maybe a
findPair key pairs =
  case findArray (\pair -> case pair of Pair candidate _ -> eqString candidate key) pairs of
    Nothing -> Nothing
    Just pair -> case pair of Pair _ value -> Just value

setPair :: forall a. String -> a -> Array (Pair String a) -> Array (Pair String a)
setPair key value pairs =
  snocArray (filterArray (\pair -> case pair of Pair candidate _ -> notBoolean (eqString candidate key)) pairs) (Pair key value)

mapMaybeArray :: forall a b. (a -> Maybe b) -> Array a -> Array b
mapMaybeArray f values =
  foldlArray (\acc value ->
    case f value of
      Nothing -> acc
      Just result -> snocArray acc result) [] values

decodeItemsWithIndex :: forall a b. (Int -> a -> Result b) -> Array a -> Result (Array b)
decodeItemsWithIndex decoder values =
  foldlWithIndexArray (\index result value ->
    bindResult result (\acc ->
      bindResult (decoder index value) (\decoded -> Ok (snocArray acc decoded)))) (Ok []) values

decodeArray :: forall a. (Json -> Result a) -> String -> Json -> Result (Array a)
decodeArray decoder key json =
  case fieldArray key json of
    Nothing -> Err (oracleError Nothing "invalid-json" (appendString "Missing array field: " key))
    Just values -> foldlArray (\result value ->
      bindResult result (\acc ->
        bindResult (decoder value) (\decoded -> Ok (snocArray acc decoded)))) (Ok []) values

requireString :: String -> Json -> Result String
requireString key json =
  case fieldString key json of
    Nothing -> Err (oracleError Nothing "invalid-json" (appendString "Missing string field: " key))
    Just value -> Ok value

requireInt :: String -> Json -> Result Int
requireInt key json =
  case fieldInt key json of
    Nothing -> Err (oracleError Nothing "invalid-json" (appendString "Missing integer field: " key))
    Just value -> Ok value

requireBoolean :: String -> Json -> Result Boolean
requireBoolean key json =
  case fieldBoolean key json of
    Nothing -> Err (oracleError Nothing "invalid-json" (appendString "Missing boolean field: " key))
    Just value -> Ok value

requireObject :: String -> Json -> Result Json
requireObject key json =
  case fieldObject key json of
    Nothing -> Err (oracleError Nothing "invalid-json" (appendString "Missing object field: " key))
    Just value -> Ok value

fieldString :: String -> Json -> Maybe String
fieldString key json =
  fieldStringImpl Nothing Just key json

fieldInt :: String -> Json -> Maybe Int
fieldInt key json =
  fieldIntImpl Nothing Just key json

fieldBoolean :: String -> Json -> Maybe Boolean
fieldBoolean key json =
  fieldBooleanImpl Nothing Just key json

fieldBooleanDefault :: String -> Boolean -> Json -> Boolean
fieldBooleanDefault key fallback json =
  maybe fallback identityBoolean (fieldBoolean key json)

fieldArray :: String -> Json -> Maybe (Array Json)
fieldArray key json =
  fieldArrayImpl Nothing Just key json

fieldObject :: String -> Json -> Maybe Json
fieldObject key json =
  fieldObjectImpl Nothing Just key json

indexArray :: forall a. Int -> Array a -> Maybe a
indexArray index values =
  indexArrayImpl Nothing Just index values

findArray :: forall a. (a -> Boolean) -> Array a -> Maybe a
findArray predicate values =
  findArrayImpl Nothing Just predicate values

findIndexArray :: forall a. (a -> Boolean) -> Array a -> Maybe Int
findIndexArray predicate values =
  findIndexArrayImpl Nothing Just predicate values

bindResult :: forall a b. Result a -> (a -> Result b) -> Result b
bindResult result f =
  case result of
    Ok value -> f value
    Err error -> Err error

mapMaybe :: forall a b. (a -> Maybe b) -> Maybe a -> Maybe b
mapMaybe f value =
  case value of
    Nothing -> Nothing
    Just inner -> f inner

maybe :: forall a b. b -> (a -> b) -> Maybe a -> b
maybe fallback f value =
  case value of
    Nothing -> fallback
    Just inner -> f inner

hasNoTabMetadataChange :: UpdateTabAction -> Boolean
hasNoTabMetadataChange details =
  case details.title of
    Just _ -> false
    Nothing ->
      case details.url of
        Just _ -> false
        Nothing ->
          case details.favIconUrl of
            Just _ -> false
            Nothing -> true

parseRuntimeWindowState :: String -> RuntimeWindowState
parseRuntimeWindowState value =
  if eqString value "normal" then Normal
  else if eqString value "minimized" then Minimized
  else if eqString value "maximized" then Maximized
  else if eqString value "fullscreen" then Fullscreen
  else if eqString value "docked" then Docked
  else UnknownWindowState value

windowStateString :: RuntimeWindowState -> String
windowStateString state =
  case state of
    Normal -> "normal"
    Minimized -> "minimized"
    Maximized -> "maximized"
    Fullscreen -> "fullscreen"
    Docked -> "docked"
    UnknownWindowState value -> value

runtimeTabTitle :: RuntimeTab -> String
runtimeTabTitle tab =
  maybe (maybe "Untitled tab" identityString tab.url) identityString tab.title

isBlankRuntimeTabUrl :: Maybe String -> Boolean
isBlankRuntimeTabUrl url =
  case url of
    Nothing -> true
    Just value -> orBoolean (eqString value "about:blank") (eqString value "about:newtab")

isLiveTabNode :: OutlineNode -> Boolean
isLiveTabNode node =
  case node.kind of
    TabKind ->
      case node.status of
        LiveStatus -> true
        _ -> false
    _ -> false

isLiveWindowNode :: OutlineNode -> Boolean
isLiveWindowNode node =
  case node.kind of
    WindowKind ->
      case node.status of
        LiveStatus -> true
        _ -> false
    _ -> false

tabNodeId :: TabId -> NodeId
tabNodeId tabId =
  NodeId (appendString "tab:" (intToString (tabIdInt tabId)))

windowNodeId :: WindowId -> NodeId
windowNodeId windowId =
  NodeId (appendString "window:" (intToString (windowIdInt windowId)))

nodeKindString :: NodeKind -> String
nodeKindString kind =
  case kind of
    WindowKind -> "window"
    TabKind -> "tab"
    GroupKind -> "group"

nodeStatusString :: NodeStatus -> String
nodeStatusString status =
  case status of
    LiveStatus -> "live"
    ClosedStatus -> "closed"
    NeutralStatus -> "neutral"

nodeIdString :: NodeId -> String
nodeIdString nodeId =
  case nodeId of
    NodeId value -> value

tabIdInt :: TabId -> Int
tabIdInt tabId =
  case tabId of
    TabId value -> value

windowIdInt :: WindowId -> Int
windowIdInt windowId =
  case windowId of
    WindowId value -> value

nodeIdEq :: NodeId -> NodeId -> Boolean
nodeIdEq left right =
  eqString (nodeIdString left) (nodeIdString right)

tabIdEq :: TabId -> TabId -> Boolean
tabIdEq left right =
  eqInt (tabIdInt left) (tabIdInt right)

windowIdEq :: WindowId -> WindowId -> Boolean
windowIdEq left right =
  eqInt (windowIdInt left) (windowIdInt right)

removeNodeId :: NodeId -> Array NodeId -> Array NodeId
removeNodeId nodeId values =
  filterArray (\candidate -> notBoolean (nodeIdEq candidate nodeId)) values

replaceNodeId :: NodeId -> NodeId -> Array NodeId -> Array NodeId
replaceNodeId oldId newId values =
  mapArray (\candidate -> if nodeIdEq candidate oldId then newId else candidate) values

identityBoolean :: Boolean -> Boolean
identityBoolean value = value

identityInt :: Int -> Int
identityInt value = value

identityString :: String -> String
identityString value = value

oracleError :: Maybe Int -> String -> String -> OracleError
oracleError step code message =
  { step: step, code: code, message: message }

oracleStepError :: Int -> String -> String -> OracleError
oracleStepError step code message =
  oracleError (Just step) code message
