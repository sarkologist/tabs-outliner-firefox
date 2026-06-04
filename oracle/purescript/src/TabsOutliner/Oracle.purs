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
  | NativeCloseTab NativeCloseTabAction
  | NativeCloseWindow WindowSelector
  | NativeOpenWindow NativeOpenWindowAction
  | NativeMoveTabToWindow NativeMoveTabAction
  | NativeMoveTabToNewWindow NativeMoveTabToNewWindowAction
  | OutlinerGroupTab CommandTabAction
  | OutlinerMoveTabToNewWindow CommandTabAction
  | OutlinerCloseTab OutlinerCloseTabAction
  | OutlinerCloseWindow OutlinerCloseWindowAction
  | OutlinerRestoreNode RestoreNodeAction
  | OutlinerRestoreNodeRejectingCreate RestoreNodeAction
  | OutlinerRestoreNodeThenAbruptRestart RestoreNodeAction
  | OutlinerDeleteWindowRejectingClose WindowSelector
  | OutlinerRestoreDeleteWindowDelayedEvent WindowSelector
  | OutlinerDeleteNode NodeSelector
  | OutlinerUndo
  | OutlinerRedo
  | InjectCloseJournalThenAbruptRestart NodeSelector
  | ConcurrentCreatedTabThenGroup ConcurrentCreatedTabThenGroupAction
  | ConcurrentUpdatedTabThenGroup ConcurrentUpdatedTabThenGroupAction
  | ConcurrentActivatedTabThenGroup ConcurrentActivatedTabThenGroupAction
  | ConcurrentFocusedWindowThenGroup ConcurrentFocusedWindowThenGroupAction
  | StaleActivationSnapshot StaleActivationSnapshotAction
  | ManualRefresh
  | RestartBackground
  | NoopAction String
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
  , restoreClosedBy :: Maybe String
  , runtimeProvenance :: Maybe String
  , restoredFromClosed :: Boolean
  }

type Outline =
  { rootIds :: Array NodeId
  , nodes :: Array OutlineNode
  }

type HistoryCheckpoint =
  { outline :: Outline
  , nextTabId :: Int
  , nextWindowId :: Int
  , movedNodeIds :: Array NodeId
  }

type OracleModel =
  { now :: Int
  , nextTabId :: Int
  , nextWindowId :: Int
  , runtimeWindows :: Array RuntimeWindow
  , runtimeTabs :: Array RuntimeTab
  , outline :: Outline
  , tabCaptures :: Array (Pair String TabId)
  , staleTabCaptures :: Array (Pair String (Array RuntimeTab))
  , windowCaptures :: Array (Pair String WindowId)
  , lastOpenedTabId :: Maybe TabId
  , lastMovedTabId :: Maybe TabId
  , lastOpenedWindowId :: Maybe WindowId
  , undoStack :: Array HistoryCheckpoint
  , redoStack :: Array HistoryCheckpoint
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
  , tabId :: Maybe TabId
  , index :: Maybe Int
  , active :: Maybe Boolean
  , title :: Maybe String
  , url :: Maybe String
  , favIconUrl :: Maybe String
  , openerTab :: Maybe TabSelector
  , captureTab :: Maybe String
  , queryLag :: Maybe Boolean
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
  , windowId :: Maybe WindowId
  , captureWindow :: Maybe String
  }

type NativeCloseTabAction =
  { tab :: TabSelector
  , order :: Maybe String
  , lastTab :: Maybe Boolean
  }

type CommandTabAction =
  { tab :: TabSelector
  , windowId :: Maybe WindowId
  }

type OutlinerCloseTabAction =
  { tab :: TabSelector
  , captureStaleTabs :: Maybe String
  }

type OutlinerCloseWindowAction =
  { window :: WindowSelector
  , captureStaleTabs :: Maybe String
  }

type RestoreNodeAction =
  { node :: NodeSelector
  , restoredTabs :: Array RuntimeTab
  , restoredWindows :: Array RuntimeWindow
  , captureRestoredTabs :: Maybe String
  , captureRestoredWindows :: Maybe String
  }

type ConcurrentCreatedTabThenGroupAction =
  { createdTab :: RuntimeTab
  , groupTab :: TabSelector
  , windowId :: Maybe WindowId
  }

type ConcurrentUpdatedTabThenGroupAction =
  { updatedTab :: RuntimeTab
  , groupTab :: TabSelector
  , windowId :: Maybe WindowId
  }

type ConcurrentActivatedTabThenGroupAction =
  { activatedTab :: TabSelector
  , groupTab :: TabSelector
  , windowId :: Maybe WindowId
  }

type ConcurrentFocusedWindowThenGroupAction =
  { focusedWindow :: WindowSelector
  , groupTab :: TabSelector
  , windowId :: Maybe WindowId
  }

type StaleActivationSnapshotAction =
  { targetTab :: TabSelector
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
  , closedBy :: Maybe String
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
foreign import lessThanInt :: Int -> Int -> Boolean
foreign import intToString :: Int -> String
foreign import appendString :: String -> String -> String
foreign import isTransientRestoredRuntimeTitleImpl :: String -> String -> Boolean
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
          , tabId: mapMaybe (\value -> Just (TabId value)) (fieldInt "tabId" json)
          , index: fieldInt "index" json
          , active: fieldBoolean "active" json
          , title: fieldString "title" json
          , url: fieldString "url" json
          , favIconUrl: fieldString "favIconUrl" json
          , openerTab: decodeOptionalTabSelectorField "openerTab" json
          , captureTab: fieldString "captureTab" json
          , queryLag: fieldBoolean "queryLag" json
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
    else if eqString actionType "nativeCloseTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab ->
        Ok (NativeCloseTab
          { tab: tab
          , order: fieldString "order" json
          , lastTab: fieldBoolean "lastTab" json
          }))
    else if eqString actionType "nativeCloseWindow" then
      bindResult (decodeWindowSelectorField "window" json) (\window -> Ok (NativeCloseWindow window))
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
          , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
          , captureWindow: fieldString "captureWindow" json
          }))
    else if eqString actionType "outlinerGroupTab" then
      bindResult (decodeCommandTabAction json) (\details -> Ok (OutlinerGroupTab details))
    else if eqString actionType "outlinerMoveTabToNewWindow" then
      bindResult (decodeCommandTabAction json) (\details -> Ok (OutlinerMoveTabToNewWindow details))
    else if eqString actionType "outlinerMoveTabCommandToNewWindow" then
      bindResult (decodeCommandTabAction json) (\details -> Ok (OutlinerMoveTabToNewWindow details))
    else if eqString actionType "outlinerCloseTab" then
      bindResult (decodeTabSelectorField "tab" json) (\tab ->
        Ok (OutlinerCloseTab
          { tab: tab
          , captureStaleTabs: fieldString "captureStaleTabs" json
          }))
    else if eqString actionType "outlinerCloseWindow" then
      bindResult (decodeWindowSelectorField "window" json) (\window ->
        Ok (OutlinerCloseWindow
          { window: window
          , captureStaleTabs: fieldString "captureStaleTabs" json
          }))
    else if eqString actionType "outlinerRestoreNode" then
      bindResult (decodeRestoreNodeAction json) (\details -> Ok (OutlinerRestoreNode details))
    else if eqString actionType "outlinerRestoreNodeRejectingCreate" then
      bindResult (decodeRestoreNodeAction json) (\details -> Ok (OutlinerRestoreNodeRejectingCreate details))
    else if eqString actionType "outlinerRestoreNodeThenAbruptRestart" then
      bindResult (decodeRestoreNodeAction json) (\details -> Ok (OutlinerRestoreNodeThenAbruptRestart details))
    else if eqString actionType "outlinerDeleteWindowRejectingClose" then
      bindResult (decodeWindowSelectorField "window" json) (\window -> Ok (OutlinerDeleteWindowRejectingClose window))
    else if eqString actionType "outlinerRestoreDeleteWindowDelayedEvent" then
      bindResult (decodeWindowSelectorField "window" json) (\window -> Ok (OutlinerRestoreDeleteWindowDelayedEvent window))
    else if eqString actionType "outlinerDeleteNode" then
      bindResult (decodeNodeSelectorField "node" json) (\node -> Ok (OutlinerDeleteNode node))
    else if eqString actionType "outlinerUndo" then
      Ok OutlinerUndo
    else if eqString actionType "outlinerRedo" then
      Ok OutlinerRedo
    else if eqString actionType "outlinerUndoThenAbruptRestart" then
      Ok OutlinerUndo
    else if eqString actionType "outlinerRedoThenAbruptRestart" then
      Ok OutlinerRedo
    else if eqString actionType "injectCloseJournalThenAbruptRestart" then
      bindResult (decodeNodeSelectorField "node" json) (\node -> Ok (InjectCloseJournalThenAbruptRestart node))
    else if eqString actionType "concurrentCreatedTabThenGroup" then
      bindResult (decodeRuntimeTabField "createdTab" json) (\createdTab ->
        bindResult (decodeTabSelectorField "groupTab" json) (\groupTab ->
          Ok (ConcurrentCreatedTabThenGroup
            { createdTab: createdTab
            , groupTab: groupTab
            , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
            })))
    else if eqString actionType "concurrentUpdatedTabThenGroup" then
      bindResult (decodeRuntimeTabField "updatedTab" json) (\updatedTab ->
        bindResult (decodeTabSelectorField "groupTab" json) (\groupTab ->
          Ok (ConcurrentUpdatedTabThenGroup
            { updatedTab: updatedTab
            , groupTab: groupTab
            , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
            })))
    else if eqString actionType "concurrentActivatedTabThenGroup" then
      bindResult (decodeTabSelectorField "activatedTab" json) (\activatedTab ->
        bindResult (decodeTabSelectorField "groupTab" json) (\groupTab ->
          Ok (ConcurrentActivatedTabThenGroup
            { activatedTab: activatedTab
            , groupTab: groupTab
            , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
            })))
    else if eqString actionType "concurrentFocusedWindowThenGroup" then
      bindResult (decodeWindowSelectorField "focusedWindow" json) (\focusedWindow ->
        bindResult (decodeTabSelectorField "groupTab" json) (\groupTab ->
          Ok (ConcurrentFocusedWindowThenGroup
            { focusedWindow: focusedWindow
            , groupTab: groupTab
            , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
            })))
    else if eqString actionType "staleActivationSnapshot" then
      bindResult (decodeTabSelectorField "targetTab" json) (\targetTab ->
        Ok (StaleActivationSnapshot { targetTab: targetTab }))
    else if eqString actionType "manualRefresh" then
      Ok ManualRefresh
    else if eqString actionType "restartBackground" then
      Ok RestartBackground
    else if isGeneratedNoopAction actionType then
      Ok (NoopAction actionType)
    else Ok (UnsupportedAction actionType))

decodeRuntimeTabField :: String -> Json -> Result RuntimeTab
decodeRuntimeTabField key json =
  bindResult (requireObject key json) decodeTab

decodeCommandTabAction :: Json -> Result CommandTabAction
decodeCommandTabAction json =
  bindResult (decodeTabSelectorField "tab" json) (\tab ->
    Ok
      { tab: tab
      , windowId: mapMaybe (\value -> Just (WindowId value)) (fieldInt "windowId" json)
      })

isGeneratedNoopAction :: String -> Boolean
isGeneratedNoopAction actionType =
  anyArray
    (\candidate -> eqString actionType candidate)
    [ "staleActivationSnapshot"
    , "staleTabCreatedEvent"
    , "staleTabUpdatedEvent"
    , "staleLiveTabUpdatedEvent"
    , "staleLiveTabUpdatedEventWithStaleQuery"
    , "staleLiveTabCreatedEventWithStaleQuery"
    , "staleLiveUpdatedEvent"
    , "staleLiveCreatedEvent"
    ]

decodeRestoreNodeAction :: Json -> Result RestoreNodeAction
decodeRestoreNodeAction json =
  bindResult (decodeNodeSelectorField "node" json) (\node ->
    bindResult (decodeOptionalArray decodeTab "restoredTabs" json) (\restoredTabs ->
      bindResult (decodeOptionalArray decodeWindow "restoredWindows" json) (\restoredWindows ->
        Ok
          { node: node
          , restoredTabs: restoredTabs
          , restoredWindows: restoredWindows
          , captureRestoredTabs: fieldString "captureRestoredTabs" json
          , captureRestoredWindows: fieldString "captureRestoredWindows" json
          })))

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
      , staleTabCaptures: []
      , windowCaptures: []
      , lastOpenedTabId: Nothing
      , lastMovedTabId: Nothing
      , lastOpenedWindowId: Nothing
      , undoStack: []
      , redoStack: []
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
    NativeCloseTab details -> applyNativeCloseTab step details model
    NativeCloseWindow selector -> applyNativeCloseWindow step selector model
    NativeOpenWindow details -> applyNativeOpenWindow step details model
    NativeMoveTabToWindow details -> applyNativeMoveTabToWindow step details model
    NativeMoveTabToNewWindow details -> applyNativeMoveTabToNewWindow step details model
    OutlinerGroupTab details -> applyTrackedTabHistory step details.tab (applyOutlinerRelocation step details.tab true details.windowId) model
    OutlinerMoveTabToNewWindow details -> applyTrackedTabHistory step details.tab (applyOutlinerRelocation step details.tab false details.windowId) model
    OutlinerCloseTab details -> applyOutlinerCloseTab step details model
    OutlinerCloseWindow details -> applyOutlinerCloseWindow step details model
    OutlinerRestoreNode details -> applyOutlinerRestoreNode step details model
    OutlinerRestoreNodeRejectingCreate details -> applyOutlinerRestoreNode step details model
    OutlinerRestoreNodeThenAbruptRestart details -> applyOutlinerRestoreNode step details model
    OutlinerDeleteWindowRejectingClose selector -> applyOutlinerDeleteWindowRejectingClose step selector model
    OutlinerRestoreDeleteWindowDelayedEvent selector -> applyOutlinerRestoreDeleteWindowDelayedEvent step selector model
    OutlinerDeleteNode selector -> applyTrackedHistory (applyOutlinerDeleteNode step selector) model
    OutlinerUndo -> applyOutlinerUndo step model
    OutlinerRedo -> applyOutlinerRedo step model
    InjectCloseJournalThenAbruptRestart _ -> Ok model
    ConcurrentCreatedTabThenGroup details -> applyConcurrentCreatedTabThenGroup step details model
    ConcurrentUpdatedTabThenGroup details -> applyConcurrentUpdatedTabThenGroup step details model
    ConcurrentActivatedTabThenGroup details -> applyConcurrentActivatedTabThenGroup step details model
    ConcurrentFocusedWindowThenGroup details -> applyConcurrentFocusedWindowThenGroup step details model
    StaleActivationSnapshot details -> applyActivateTab step details.targetTab model
    ManualRefresh -> applyCurrentRuntimeRefresh model
    RestartBackground -> Ok model
    NoopAction _ -> Ok model
    UnsupportedAction actionType -> Err (oracleStepError step "unsupported-action" (appendString "Unsupported action: " actionType))

applyCurrentRuntimeRefresh :: OracleModel -> Result OracleModel
applyCurrentRuntimeRefresh model =
  Ok model { outline = refreshOutlineDirectLiveTabOrderFromRuntime model.runtimeTabs model.outline }

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
      , restoreClosedBy: Nothing
      , runtimeProvenance: Nothing
      , restoredFromClosed: false
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
tabToNode _now _parentId tab =
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
  , restoreClosedBy: Nothing
  , runtimeProvenance: Nothing
  , restoredFromClosed: false
  }

applyOpenTab :: Int -> OpenTabAction -> OracleModel -> Result OracleModel
applyOpenTab step details model =
  case details.staleQueryFromCapture of
    Just name ->
      case findPair name model.staleTabCaptures of
        Nothing -> Err (oracleStepError step "missing-capture" (appendString "Missing stale tab capture: " name))
        Just _ -> applyOpenTabCurrentTruth step details model
    Nothing -> applyOpenTabCurrentTruth step details model

applyOpenTabCurrentTruth :: Int -> OpenTabAction -> OracleModel -> Result OracleModel
applyOpenTabCurrentTruth step details model =
      bindResult (resolveWindowSelector step details.window model) (\window ->
        bindResult (resolveMaybeTabSelector step details.openerTab model) (\opener ->
          let
            tabId = maybe (TabId model.nextTabId) identityTabId details.tabId
            tabsBeforeCreate = tabsInWindow model window.id
            active = maybe true identityBoolean details.active
            tab =
              { id: tabId
              , windowId: window.id
              , index: maybe (lengthArray tabsBeforeCreate) identityInt details.index
              , active: active
              , openerTabId: mapMaybe (\value -> Just value.id) opener
              , url: maybe (Just (appendString "https://domain.example/" (intToString (tabIdInt tabId)))) Just details.url
              , title: maybe (Just (appendString "Domain " (intToString (tabIdInt tabId)))) Just details.title
              , favIconUrl: details.favIconUrl
              , incognito: false
              }
            runtimeTabs = createRuntimeTab model.runtimeTabs tab
            existingTabs = filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) (tabsInWindowFrom runtimeTabs window.id)
            outline = addLiveTabToOutlineWithExistingTabs model.outline model.now tab existingTabs
            nextModel = setTabCapture details.captureTab tabId
              model
                { nextTabId = maxInt model.nextTabId (addInt (tabIdInt tabId) 1)
                , runtimeTabs = runtimeTabs
                , outline = if active then setActiveTabInOutlineWindow tab.windowId tab.id outline else outline
                , lastOpenedTabId = Just tabId
                }
          in Ok nextModel))

applyActivateTab :: Int -> TabSelector -> OracleModel -> Result OracleModel
applyActivateTab step selector model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    let
      runtimeTabs = setRuntimeActiveTab tab.id tab.windowId model.runtimeTabs
      outline = setActiveTabInOutlineWindow tab.windowId tab.id model.outline
    in
      Ok model
        { runtimeTabs = runtimeTabs
        , outline = refreshOutlineDirectLiveTabOrderFromRuntime runtimeTabs outline
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
    let
      outline = setActiveWindowInOutline window.id model.outline
    in
      Ok model
        { runtimeWindows = mapArray (\candidate -> candidate { focused = windowIdEq candidate.id window.id }) model.runtimeWindows
        , outline = refreshOutlineDirectLiveTabOrderFromRuntime model.runtimeTabs outline
        })

applyNativeSetWindowState :: Int -> WindowSelector -> RuntimeWindowState -> OracleModel -> Result OracleModel
applyNativeSetWindowState step selector state model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    Ok model
      { runtimeWindows = mapArray
          (\candidate -> if windowIdEq candidate.id window.id then candidate { state = Just state } else candidate)
          model.runtimeWindows
      })

applyNativeCloseTab :: Int -> NativeCloseTabAction -> OracleModel -> Result OracleModel
applyNativeCloseTab step details model =
  bindResult (resolveTabSelector step details.tab model) (\tab ->
    let
      windowTabs = tabsInWindow model tab.windowId
      runtimeTabsWithoutTab = filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) model.runtimeTabs
    in
      if eqInt (lengthArray windowTabs) 1 then
        let
          runtimeTabs = reindexAllRuntimeTabs runtimeTabsWithoutTab
          runtimeWindows = filterArray (\window -> notBoolean (windowIdEq window.id tab.windowId)) model.runtimeWindows
          closingNodeId = liveWindowNodeIdForRuntimeWindow tab.windowId model.outline
          closingWindowNode = findNode closingNodeId model.outline
        in
          if nativeCloseTabHasWindowCloseEvidence details closingWindowNode then
            let
              outlineWithPromoted = promoteForeignLiveWindowsAfterClosingWindow closingNodeId tab.windowId model.outline
              outline = markClosedSubtreeById closingNodeId model.now outlineWithPromoted
            in
              Ok model
                { runtimeTabs = runtimeTabs
                , runtimeWindows = runtimeWindows
                , outline = setActiveWindowInOutlineIfFocused runtimeWindows outline
                }
          else
            let
              outlineWithoutTab = deleteLiveTabNodePromotingChildren (liveTabNodeIdForRuntimeTab tab.id model.outline) model.outline
              outlineWithMissingWindowCleanup = closeOutlineWindowsMissingFromRuntime runtimeWindows outlineWithoutTab
            in
              Ok model
                { runtimeTabs = runtimeTabs
                , runtimeWindows = runtimeWindows
                , outline = setActiveWindowInOutlineIfFocused runtimeWindows outlineWithMissingWindowCleanup
                }
      else
        let
          runtimeTabs = reindexAllRuntimeTabs runtimeTabsWithoutTab
          activeTab = findArray (\candidate -> andBoolean (windowIdEq candidate.windowId tab.windowId) candidate.active) runtimeTabs
          outline = deleteLiveTabNodePromotingChildren (liveTabNodeIdForRuntimeTab tab.id model.outline) model.outline
          activeOutline = case activeTab of
            Nothing -> outline
            Just nextActiveTab -> setActiveTabInOutlineWindow nextActiveTab.windowId nextActiveTab.id outline
        in
          Ok model
            { runtimeTabs = runtimeTabs
            , outline = activeOutline
            })

nativeCloseTabHasWindowCloseEvidence :: NativeCloseTabAction -> Maybe OutlineNode -> Boolean
nativeCloseTabHasWindowCloseEvidence details windowNode =
  case details.lastTab of
    Just true -> true
    _ ->
      case details.order of
        Nothing -> true
        Just order ->
          if orBoolean (eqString order "tabRemovedThenSessionChanged") (eqString order "sessionChangedThenTabRemoved") then true
          else if eqString order "sessionChangedOnly" then sessionOnlyLastTabPreservesWindow windowNode
          else false

sessionOnlyLastTabPreservesWindow :: Maybe OutlineNode -> Boolean
sessionOnlyLastTabPreservesWindow windowNode =
  case windowNode of
    Nothing -> true
    Just node ->
      case node.runtimeProvenance of
        Just provenance -> notBoolean (eqString provenance "commandCreated")
        Nothing -> true

applyNativeCloseWindow :: Int -> WindowSelector -> OracleModel -> Result OracleModel
applyNativeCloseWindow step selector model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    let
      runtimeTabs = filterArray (\tab -> notBoolean (windowIdEq tab.windowId window.id)) model.runtimeTabs
      runtimeWindows = filterArray (\candidate -> notBoolean (windowIdEq candidate.id window.id)) model.runtimeWindows
      closingNodeId = liveWindowNodeIdForRuntimeWindow window.id model.outline
      outlineWithPromoted = promoteForeignLiveWindowsAfterClosingWindow closingNodeId window.id model.outline
      outline = markClosedSubtreeById closingNodeId model.now outlineWithPromoted
    in
      Ok model
        { runtimeTabs = runtimeTabs
        , runtimeWindows = runtimeWindows
        , outline = setActiveWindowInOutlineIfFocused runtimeWindows outline
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
      focusedOutline = if focused then setActiveWindowInOutline windowId outlineWithTabs else outlineWithTabs
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
            , outline = focusedOutline
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
      windowId = maybe (WindowId model.nextWindowId) identityWindowId details.windowId
      focused = maybe true identityBoolean details.active
      window = { id: windowId, focused: focused, incognito: false, state: Nothing }
      runtimeWindows = snocArray
        (if focused then mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows else model.runtimeWindows)
        window
      outline = addLiveWindowToOutline model.outline model.now window (Just "browserCreated")
      withWindow = setWindowCapture details.captureWindow windowId
        model
          { nextWindowId = maxInt model.nextWindowId (addInt (windowIdInt windowId) 1)
          , runtimeWindows = runtimeWindows
          , outline = if focused then setActiveWindowInOutline windowId outline else outline
          , lastOpenedWindowId = Just windowId
          }
    in moveRuntimeTabAndOutline step tab windowId (Just 0) (Just focused) false Nothing withWindow)

applyOutlinerRelocation :: Int -> TabSelector -> Boolean -> Maybe WindowId -> OracleModel -> Result OracleModel
applyOutlinerRelocation step selector wrap maybeWindowId model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    let
      windowId = maybe (WindowId model.nextWindowId) identityWindowId maybeWindowId
      window = { id: windowId, focused: true, incognito: false, state: Nothing }
      runtimeWindows = snocArray (mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows) window
      withWindow =
        model
          { nextWindowId = maxInt model.nextWindowId (addInt (windowIdInt windowId) 1)
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
moveRuntimeTabAndOutline _step tab targetWindowId index active commandCreated wrapMode model =
  let
    targetIndex = maybe (lengthArray (tabsInWindow model targetWindowId)) identityInt index
    activeValue = maybe tab.active identityBoolean active
    movingNodeIdBeforeMove = liveTabNodeIdForRuntimeTab tab.id model.outline
    movedRuntimeTabs =
      if commandCreated then moveRuntimeTabSubtree movingNodeIdBeforeMove tab.id targetWindowId targetIndex model.outline model.runtimeTabs
      else moveRuntimeTab tab.id targetWindowId targetIndex model.runtimeTabs
    activeRuntimeTabs = if commandCreated then applyCommandMoveActiveState tab.id activeValue movedRuntimeTabs else applyNativeMoveActiveState tab.id tab.windowId targetWindowId activeValue movedRuntimeTabs
    runtimeTabs = reindexAllRuntimeTabs activeRuntimeTabs
    runtimeWindowsBeforeFocus = removeEmptyRuntimeWindows runtimeTabs model.runtimeWindows
    runtimeWindows = if activeValue then mapArray (\window -> window { focused = windowIdEq window.id targetWindowId }) runtimeWindowsBeforeFocus else runtimeWindowsBeforeFocus
    outlineWithCommandWindow = case wrapMode of
      Nothing -> if commandCreated then addLiveWindowToOutline model.outline model.now (runtimeWindowForId targetWindowId runtimeWindows) (Just "commandCreated") else model.outline
      Just true -> model.outline
      Just false -> model.outline
    movingNodeId = liveTabNodeIdForRuntimeTab tab.id outlineWithCommandWindow
    outlineBeforeMove =
      if commandCreated then outlineWithCommandWindow
      else promoteSourceWindowLiveChildrenBeforeMove movingNodeId tab.windowId outlineWithCommandWindow
    outline = case wrapMode of
      Just true -> wrapLiveTabInCommandWindow movingNodeId targetWindowId model.now outlineBeforeMove
      Just false -> moveLiveTabToNewRootWindow movingNodeId targetWindowId model.now outlineBeforeMove
      Nothing -> moveLiveTabToWindow movingNodeId targetWindowId targetIndex model.now outlineBeforeMove
  in
    let
      outlineWithRefs =
        if commandCreated then updateLiveTabWindowRefForSubtree movingNodeId targetWindowId outline
        else updateLiveTabWindowRefForNode movingNodeId targetWindowId outline
      outlineWithActiveTabs = setActiveTabsInOutlineFromRuntime runtimeTabs outlineWithRefs
      outlineWithActiveWindow = setActiveWindowInOutlineIfFocused runtimeWindows outlineWithActiveTabs
      closedOutline =
        if commandCreated then closeOutlineWindowsMissingFromRuntime runtimeWindows outlineWithActiveWindow
        else closeHistoryOutlineWindowsMissingFromRuntime runtimeWindows outlineWithActiveWindow
      finalOutline =
        if commandCreated then closedOutline
        else refreshOutlineDirectLiveTabOrderFromRuntime runtimeTabs closedOutline
      finalRuntimeTabs = case wrapMode of
        Just false -> syncRuntimeOrderFromOutline finalOutline runtimeTabs
        _ -> runtimeTabs
    in
      Ok model
        { runtimeTabs = finalRuntimeTabs
        , runtimeWindows = runtimeWindows
        , outline = finalOutline
        , lastMovedTabId = Just tab.id
        , lastOpenedWindowId = Just targetWindowId
        }

applyOutlinerCloseTab :: Int -> OutlinerCloseTabAction -> OracleModel -> Result OracleModel
applyOutlinerCloseTab step details model =
  bindResult (resolveTabSelector step details.tab model) (\tab ->
    Ok (setStaleTabsCapture details.captureStaleTabs [tab] model)
      { runtimeTabs = reindexAllRuntimeTabs (filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) model.runtimeTabs)
      , runtimeWindows = removeEmptyRuntimeWindows (filterArray (\candidate -> notBoolean (tabIdEq candidate.id tab.id)) model.runtimeTabs) model.runtimeWindows
      , outline = closeTabNodeByIdWithSessionAndClosedBy (liveTabNodeIdForRuntimeTab tab.id model.outline) (Just "recent-session") (Just "outliner") model.now model.outline
      })

applyOutlinerCloseWindow :: Int -> OutlinerCloseWindowAction -> OracleModel -> Result OracleModel
applyOutlinerCloseWindow step details model =
  bindResult (resolveWindowSelector step details.window model) (\window ->
    Ok (setStaleTabsCapture details.captureStaleTabs (tabsInWindow model window.id) model)
      { runtimeTabs = filterArray (\tab -> notBoolean (windowIdEq tab.windowId window.id)) model.runtimeTabs
      , runtimeWindows = filterArray (\candidate -> notBoolean (windowIdEq candidate.id window.id)) model.runtimeWindows
      , outline =
          let
            closingNodeId = liveWindowNodeIdForRuntimeWindow window.id model.outline
            outlineWithPromoted = promoteForeignLiveWindowsAfterClosingWindow closingNodeId window.id model.outline
          in
            markClosedSubtreeByIdWithClosedBy closingNodeId (Just "outliner") model.now outlineWithPromoted
      })

applyOutlinerRestoreNode :: Int -> RestoreNodeAction -> OracleModel -> Result OracleModel
applyOutlinerRestoreNode step details model =
  bindResult (resolveNodeSelector step details.node model) (\node ->
    case node.kind of
      WindowKind ->
        case indexArray 0 details.restoredWindows of
          Nothing -> Err (oracleStepError step "missing-runtime-window" "Restore window action did not provide a restored runtime window")
          Just window ->
            let
              runtimeWindows = appendRestoredRuntimeWindows details.restoredWindows (clearRuntimeWindowFocusIfRestoredFocused details.restoredWindows model.runtimeWindows)
              runtimeTabs = reindexAllRuntimeTabs (appendRestoredRuntimeTabs details.restoredTabs model.runtimeTabs)
              outline = restoreClosedWindowSubtree node.id details.restoredWindows details.restoredTabs model.outline
              activeOutline = if window.focused then setActiveWindowInOutline window.id outline else outline
              focusedOutline = case findArray (\tab -> tab.active) details.restoredTabs of
                Nothing -> activeOutline
                Just tab -> setActiveTabInOutlineWindow tab.windowId tab.id activeOutline
              nextModel = setRestoredCaptures details
                model
                  { runtimeWindows = runtimeWindows
                  , runtimeTabs = runtimeTabs
                  , outline = focusedOutline
                  , nextTabId = maxInt model.nextTabId (addInt 1 (maxRuntimeTabId details.restoredTabs))
                  , nextWindowId = maxInt model.nextWindowId (addInt 1 (maxRuntimeWindowId details.restoredWindows))
                  , lastOpenedWindowId = Just window.id
                  , lastOpenedTabId = firstRuntimeTabId details.restoredTabs model.lastOpenedTabId
                  }
            in Ok nextModel
      TabKind ->
        case indexArray 0 details.restoredTabs of
          Nothing -> Err (oracleStepError step "missing-runtime-tab" "Restore tab action did not provide a restored runtime tab")
          Just tab ->
            let
              restoredWindows = restoredWindowsForRestoredTab tab details.restoredWindows model.runtimeWindows
              runtimeWindows = appendRestoredRuntimeWindows restoredWindows (clearRuntimeWindowFocusIfRestoredFocused restoredWindows model.runtimeWindows)
              runtimeTabs = reindexAllRuntimeTabs (appendRestoredRuntimeTabs details.restoredTabs model.runtimeTabs)
              outline = restoreClosedTabNode node.id tab restoredWindows model.outline
              activeOutline = if tab.active then setActiveTabInOutlineWindow tab.windowId tab.id (setActiveWindowInOutline tab.windowId outline) else outline
              nextModel = setRestoredCaptures details
                model
                  { runtimeWindows = runtimeWindows
                  , runtimeTabs = runtimeTabs
                  , outline = activeOutline
                  , nextTabId = maxInt model.nextTabId (addInt 1 (maxRuntimeTabId details.restoredTabs))
                  , nextWindowId = maxInt model.nextWindowId (addInt 1 (maxRuntimeWindowId details.restoredWindows))
                  , lastOpenedWindowId = firstRuntimeWindowId restoredWindows model.lastOpenedWindowId
                  , lastOpenedTabId = Just tab.id
                  }
            in Ok nextModel
      GroupKind -> Err (oracleStepError step "unsupported-action" "Restore group is outside the current oracle restore slice"))

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

applyOutlinerDeleteWindowRejectingClose :: Int -> WindowSelector -> OracleModel -> Result OracleModel
applyOutlinerDeleteWindowRejectingClose step selector model =
  bindResult (resolveWindowSelector step selector model) (\window ->
    let
      nodeId = liveWindowNodeIdForRuntimeWindow window.id model.outline
      subtreeIds = subtreeNodeIds nodeId model.outline
      liveTabIds = liveTabIdsForNodes subtreeIds model.outline
      liveWindowIds = liveWindowIdsForNodes subtreeIds model.outline
      runtimeTabs = filterArray
        (\tab -> andBoolean
          (notBoolean (anyArray (\id -> tabIdEq id tab.id) liveTabIds))
          (notBoolean (anyArray (\id -> windowIdEq id tab.windowId) liveWindowIds)))
        model.runtimeTabs
      runtimeWindows = removeEmptyRuntimeWindows runtimeTabs (filterArray (\candidate -> notBoolean (anyArray (\id -> windowIdEq id candidate.id) liveWindowIds)) model.runtimeWindows)
    in
      Ok model
        { runtimeTabs = reindexAllRuntimeTabs runtimeTabs
        , runtimeWindows = runtimeWindows
        , outline = deleteNodes subtreeIds model.outline
        })

applyOutlinerRestoreDeleteWindowDelayedEvent :: Int -> WindowSelector -> OracleModel -> Result OracleModel
applyOutlinerRestoreDeleteWindowDelayedEvent step selector model =
  bindResult (applyOutlinerDeleteWindowRejectingClose step selector model) (\deleted ->
    Ok deleted
      { runtimeWindows = mapArray (\window -> window { focused = false }) deleted.runtimeWindows
      , outline = clearActiveWindowsInOutline deleted.outline
      })

applyTrackedHistory :: (OracleModel -> Result OracleModel) -> OracleModel -> Result OracleModel
applyTrackedHistory apply model =
  bindResult (apply model) (\next ->
    Ok next
      { undoStack = snocArray model.undoStack (checkpointForHistory model next)
      , redoStack = []
      })

applyTrackedTabHistory :: Int -> TabSelector -> (OracleModel -> Result OracleModel) -> OracleModel -> Result OracleModel
applyTrackedTabHistory step selector apply model =
  bindResult (resolveTabSelector step selector model) (\tab ->
    let movedNodeId = liveTabNodeIdForRuntimeTab tab.id model.outline in
      bindResult (apply model) (\next ->
        Ok next
          { undoStack = snocArray model.undoStack (checkpointForHistoryWithMovedNodes model next [movedNodeId])
          , redoStack = []
          }))

applyOutlinerUndo :: Int -> OracleModel -> Result OracleModel
applyOutlinerUndo _step model =
  case lastArray model.undoStack of
    Nothing -> Ok model
    Just checkpoint ->
      let
        current = checkpointModel model
        restored = restoreHistoryCheckpoint checkpoint model
      in
        Ok restored
          { undoStack = dropLastArray model.undoStack
          , redoStack = snocArray model.redoStack current
          }

applyOutlinerRedo :: Int -> OracleModel -> Result OracleModel
applyOutlinerRedo _step model =
  case lastArray model.redoStack of
    Nothing -> Ok model
    Just checkpoint ->
      let
        current = checkpointModel model
        restored = restoreHistoryCheckpoint checkpoint model
      in
        Ok restored
          { undoStack = snocArray model.undoStack current
          , redoStack = dropLastArray model.redoStack
          }

checkpointModel :: OracleModel -> HistoryCheckpoint
checkpointModel model =
  { outline: model.outline
  , nextTabId: model.nextTabId
  , nextWindowId: model.nextWindowId
  , movedNodeIds: []
  }

checkpointForHistory :: OracleModel -> OracleModel -> HistoryCheckpoint
checkpointForHistory before after =
  checkpointForHistoryWithMovedNodes before after []

checkpointForHistoryWithMovedNodes :: OracleModel -> OracleModel -> Array NodeId -> HistoryCheckpoint
checkpointForHistoryWithMovedNodes before after movedNodeIds =
  { outline: before.outline
  , nextTabId: before.nextTabId
  , nextWindowId: before.nextWindowId
  , movedNodeIds: appendMissingNodeIds movedNodeIds (changedLiveTabPlacementNodeIds before.outline after.outline)
  }

restoreHistoryCheckpoint :: HistoryCheckpoint -> OracleModel -> OracleModel
restoreHistoryCheckpoint checkpoint model =
  let
    historyBase =
      preserveCurrentLiveTabMetadata
        (preserveCurrentCohabitingRuntimeScopes checkpoint.movedNodeIds checkpoint.outline model.outline model.runtimeWindows model.runtimeTabs)
        model.outline
    baseSyncedRuntimeTabs = syncRuntimeOrderFromOpenOutlineWindows historyBase model.runtimeWindows model.runtimeTabs
    baseRuntimeWindows = removeEmptyRuntimeWindows baseSyncedRuntimeTabs model.runtimeWindows
    replayedOutline = moveHistoryMovedNodesToScopeEnd historyBase baseRuntimeWindows checkpoint.movedNodeIds
      (orderOpenHistoryReplayChildrenFromReference checkpoint.outline baseRuntimeWindows
        (orderHistoryReplayChildrenFromReference historyBase
        (reconcileHistoryOutlineWithRuntime historyBase baseRuntimeWindows baseSyncedRuntimeTabs))
      )
    syncedRuntimeTabs = syncRuntimeOrderFromOpenOutlineWindows replayedOutline baseRuntimeWindows baseSyncedRuntimeTabs
    runtimeWindows = removeEmptyRuntimeWindows syncedRuntimeTabs baseRuntimeWindows
    outline = normalizeRootOrderByNodeOrder
      (alignHistoryRuntimeWindowProvenance model.outline
        (reconcileHistoryOutlineWithRuntime replayedOutline runtimeWindows syncedRuntimeTabs))
  in
    model
      { outline = outline
      , runtimeTabs = syncedRuntimeTabs
      , runtimeWindows = runtimeWindows
      , nextTabId = maxInt checkpoint.nextTabId (addInt 1 (maxRuntimeTabId model.runtimeTabs))
      , nextWindowId = maxInt checkpoint.nextWindowId (addInt 1 (maxRuntimeWindowId model.runtimeWindows))
      }

reconcileHistoryOutlineWithRuntime :: Outline -> Array RuntimeWindow -> Array RuntimeTab -> Outline
reconcileHistoryOutlineWithRuntime outline runtimeWindows runtimeTabs =
  let
    withWindows = foldlArray ensureHistoryRuntimeWindowNode outline runtimeWindows
    withTabs = foldlArray ensureHistoryRuntimeTabNode withWindows (sortTabs runtimeTabs)
    withActiveTabs = setActiveTabsInOutlineFromRuntime runtimeTabs withTabs
    withActiveWindow = setActiveWindowInOutlineIfFocused runtimeWindows withActiveTabs
  in
    closeHistoryOutlineWindowsMissingFromRuntime runtimeWindows withActiveWindow

ensureHistoryRuntimeWindowNode :: Outline -> RuntimeWindow -> Outline
ensureHistoryRuntimeWindowNode outline window =
  let
    nodeId = liveWindowNodeIdForRuntimeWindow window.id outline
    fallbackId = windowNodeId window.id
    existingId = case findNode nodeId outline of
      Just _ -> nodeId
      Nothing -> fallbackId
    node =
      { id: existingId
      , kind: WindowKind
      , status: LiveStatus
      , parentId: Nothing
      , childIds: case findNode existingId outline of
          Nothing -> []
          Just existing -> existing.childIds
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
      , restoreClosedBy: Nothing
      , runtimeProvenance: case findNode existingId outline of
          Nothing -> Nothing
          Just existing -> existing.runtimeProvenance
      , restoredFromClosed: case findNode existingId outline of
          Nothing -> false
          Just existing -> existing.restoredFromClosed
      }
    withNode = case findNode existingId outline of
      Nothing -> addNode outline node
      Just _ -> replaceNode outline node
    withoutStaleParents = detachNode existingId withNode
    withParent = replaceNode withoutStaleParents node
  in
    if anyArray (\rootId -> nodeIdEq rootId existingId) withParent.rootIds then withParent
    else withParent { rootIds = snocArray withParent.rootIds existingId }

ensureHistoryRuntimeTabNode :: Outline -> RuntimeTab -> Outline
ensureHistoryRuntimeTabNode outline tab =
  let
    parentId = liveWindowNodeIdForRuntimeWindow tab.windowId outline
    nodeId = liveTabNodeIdForRuntimeTab tab.id outline
    existing = findNode nodeId outline
    childIds = case existing of
      Nothing -> []
      Just existingNode -> existingNode.childIds
    title = case existing of
      Nothing -> runtimeTabTitle tab
      Just existingNode -> existingNode.title
    url = case existing of
      Nothing -> tab.url
      Just existingNode -> existingNode.url
    favIconUrl = case existing of
      Nothing -> tab.favIconUrl
      Just existingNode -> existingNode.favIconUrl
    node =
      { id: nodeId
      , kind: TabKind
      , status: LiveStatus
      , parentId: Just parentId
      , childIds: childIds
      , title: title
      , url: url
      , favIconUrl: favIconUrl
      , active: Just tab.active
      , liveWindowId: Just tab.windowId
      , liveTabId: Just tab.id
      , restoreSessionId: Nothing
      , restoreUrl: Nothing
      , restoreTitle: Nothing
      , restoreFavIconUrl: Nothing
      , restoreClosedBy: Nothing
      , runtimeProvenance: Nothing
      , restoredFromClosed: case existing of
          Nothing -> false
          Just existingNode -> existingNode.restoredFromClosed
      }
    withNode = case existing of
      Nothing -> addNode outline node
      Just _ -> replaceNode outline node
    currentParent = case existing of
      Nothing -> Nothing
      Just existingNode -> existingNode.parentId
  in
    case currentParent of
      Just existingParent ->
        if nodeIdEq existingParent parentId then
          if parentHasChild parentId nodeId withNode then withNode
          else appendChild parentId nodeId withNode
        else replaceNode (appendChild parentId nodeId (detachNode nodeId withNode)) node
      Nothing -> replaceNode (appendChild parentId nodeId (detachNode nodeId withNode)) node

parentHasChild :: NodeId -> NodeId -> Outline -> Boolean
parentHasChild parentId childId outline =
  anyArray
    (\candidate -> nodeIdEq candidate childId)
    (requireNodeOr parentId outline (emptyTabNode parentId)).childIds

moveHistoryMovedNodesToScopeEnd :: Outline -> Array RuntimeWindow -> Array NodeId -> Outline -> Outline
moveHistoryMovedNodesToScopeEnd reference runtimeWindows movedNodeIds outline =
  foldlArray
    (\current nodeId ->
      if movedNodeHasOpenReferenceParent reference runtimeWindows nodeId then current
      else case findNode nodeId current of
        Nothing -> current
        Just node ->
          case node.parentId of
            Nothing -> current
            Just parentId ->
              if parentHasChild parentId nodeId current then
                appendChild parentId nodeId current
              else current)
    outline
    movedNodeIds

movedNodeHasOpenReferenceParent :: Outline -> Array RuntimeWindow -> NodeId -> Boolean
movedNodeHasOpenReferenceParent reference runtimeWindows nodeId =
  case findNode nodeId reference of
    Nothing -> false
    Just node ->
      case node.parentId of
        Nothing -> false
        Just parentId ->
          case findNode parentId reference of
            Nothing -> false
            Just parent ->
              case parent.liveWindowId of
                Nothing -> false
                Just windowId -> andBoolean (isLiveWindowNode parent) (runtimeWindowIsOpen windowId runtimeWindows)

orderHistoryReplayChildrenFromReference :: Outline -> Outline -> Outline
orderHistoryReplayChildrenFromReference reference outline =
  outline
    { nodes = mapArray
        (\node ->
          case findNode node.id reference of
            Nothing -> node
            Just referenceNode -> node { childIds = orderNodeIdsFromReference referenceNode.childIds node.childIds })
        outline.nodes
    }

orderOpenHistoryReplayChildrenFromReference :: Outline -> Array RuntimeWindow -> Outline -> Outline
orderOpenHistoryReplayChildrenFromReference reference runtimeWindows outline =
  outline
    { nodes = mapArray
        (\node ->
          case findNode node.id reference of
            Nothing -> node
            Just referenceNode ->
              if shouldOrderOpenHistoryReplayChildrenFromReference reference referenceNode outline node runtimeWindows then
                node { childIds = orderNodeIdsFromReference referenceNode.childIds node.childIds }
              else node)
        outline.nodes
    }

shouldOrderOpenHistoryReplayChildrenFromReference :: Outline -> OutlineNode -> Outline -> OutlineNode -> Array RuntimeWindow -> Boolean
shouldOrderOpenHistoryReplayChildrenFromReference reference referenceNode outline node runtimeWindows =
  case referenceNode.liveWindowId of
    Nothing -> false
    Just referenceWindowId ->
      case node.liveWindowId of
        Nothing -> false
        Just windowId ->
          andBoolean
            (sameOpenLiveWindow referenceNode node runtimeWindows)
            (sameTabIdOrder
              (liveTabIdsAlreadyInRuntimeWindow referenceNode.id referenceWindowId reference)
              (liveTabIdsAlreadyInRuntimeWindow node.id windowId outline))

sameOpenLiveWindow :: OutlineNode -> OutlineNode -> Array RuntimeWindow -> Boolean
sameOpenLiveWindow referenceNode node runtimeWindows =
  case referenceNode.liveWindowId of
    Nothing -> false
    Just referenceWindowId ->
      case node.liveWindowId of
        Nothing -> false
        Just windowId ->
          andBoolean
            (andBoolean (isLiveWindowNode referenceNode) (isLiveWindowNode node))
            (andBoolean (windowIdEq referenceWindowId windowId) (runtimeWindowIsOpen windowId runtimeWindows))

orderNodeIdsFromReference :: Array NodeId -> Array NodeId -> Array NodeId
orderNodeIdsFromReference referenceIds childIds =
  let
    referenced = filterArray (\childId -> nodeIdInArray childId childIds) referenceIds
    remaining = filterArray (\childId -> notBoolean (nodeIdInArray childId referenced)) childIds
  in
    appendArray referenced remaining

sameTabIdOrder :: Array TabId -> Array TabId -> Boolean
sameTabIdOrder left right =
  andBoolean
    (eqInt (lengthArray left) (lengthArray right))
    (foldlWithIndexArray
      (\index sameSoFar leftId ->
        andBoolean sameSoFar
          (case indexArray index right of
            Nothing -> false
            Just rightId -> tabIdEq leftId rightId))
      true
      left)

normalizeRootOrderByNodeOrder :: Outline -> Outline
normalizeRootOrderByNodeOrder outline =
  outline
    { rootIds = mapMaybeArray
        (\node -> case node.parentId of
          Nothing -> Just node.id
          Just _ -> Nothing)
        outline.nodes
    }

preserveCurrentLiveTabMetadata :: Outline -> Outline -> Outline
preserveCurrentLiveTabMetadata target current =
  foldlArray
    (\outline currentNode ->
      case currentNode.liveTabId of
        Nothing -> outline
        Just tabId ->
          if isLiveTabNode currentNode then
            let
              targetNodeId = liveTabNodeIdForRuntimeTab tabId outline
            in
              case findNode targetNodeId outline of
                Nothing -> outline
                Just targetNode ->
                  if isLiveTabNode targetNode then
                    replaceNode outline
                      (targetNode
                        { title = currentNode.title
                        , url = currentNode.url
                        , favIconUrl = currentNode.favIconUrl
                        })
                  else outline
          else outline)
    target
    current.nodes

changedLiveTabPlacementNodeIds :: Outline -> Outline -> Array NodeId
changedLiveTabPlacementNodeIds before after =
  foldlArray
    (\ids beforeNode ->
      case beforeNode.liveTabId of
        Nothing -> ids
        Just tabId ->
          case findNode (liveTabNodeIdForRuntimeTab tabId after) after of
            Nothing -> ids
            Just afterNode ->
              if andBoolean
                (isLiveTabNode beforeNode)
                (andBoolean
                  (isLiveTabNode afterNode)
                  (liveTabPlacementChanged beforeNode afterNode)) then
                snocArray ids beforeNode.id
              else ids)
    []
    before.nodes

liveTabPlacementChanged :: OutlineNode -> OutlineNode -> Boolean
liveTabPlacementChanged beforeNode afterNode =
  orBoolean
    (notBoolean (maybeNodeIdEq beforeNode.parentId afterNode.parentId))
    (notBoolean (maybeWindowIdEq beforeNode.liveWindowId afterNode.liveWindowId))

preserveCurrentCohabitingRuntimeScopes :: Array NodeId -> Outline -> Outline -> Array RuntimeWindow -> Array RuntimeTab -> Outline
preserveCurrentCohabitingRuntimeScopes movedNodeIds target current runtimeWindows runtimeTabs =
  foldlArray
    (\outline node ->
      if shouldPreserveCurrentRuntimeScope node runtimeWindows runtimeTabs then
        copyCurrentRuntimeScope movedNodeIds node.id current outline
      else outline)
    target
    current.nodes

shouldPreserveCurrentRuntimeScope :: OutlineNode -> Array RuntimeWindow -> Array RuntimeTab -> Boolean
shouldPreserveCurrentRuntimeScope node runtimeWindows runtimeTabs =
  case node.liveWindowId of
    Nothing -> false
    Just windowId ->
      andBoolean
        (isLiveWindowNode node)
        (andBoolean
          (runtimeWindowIsOpen windowId runtimeWindows)
          (lessThanInt 1 (lengthArray (tabsInWindowFrom runtimeTabs windowId))))

runtimeWindowIsOpen :: WindowId -> Array RuntimeWindow -> Boolean
runtimeWindowIsOpen windowId runtimeWindows =
  anyArray (\window -> windowIdEq window.id windowId) runtimeWindows

copyCurrentRuntimeScope :: Array NodeId -> NodeId -> Outline -> Outline -> Outline
copyCurrentRuntimeScope movedNodeIds runtimeWindowNodeId current target =
  let
    ids = subtreeNodeIdsExcludingNestedLiveWindows runtimeWindowNodeId current
    copied = foldlArray (copyCurrentNode movedNodeIds current) target (filterArray (\id -> notBoolean (nodeIdInArray id movedNodeIds)) ids)
    currentWindow = findNode runtimeWindowNodeId current
  in
    case currentWindow of
      Just node ->
        case node.parentId of
          Nothing ->
            if anyArray (\rootId -> nodeIdEq rootId runtimeWindowNodeId) copied.rootIds then copied
            else copied { rootIds = snocArray copied.rootIds runtimeWindowNodeId }
          Just _ -> copied
      Nothing -> copied

copyCurrentNode :: Array NodeId -> Outline -> Outline -> NodeId -> Outline
copyCurrentNode movedNodeIds current target nodeId =
  case findNode nodeId current of
    Nothing -> target
    Just node ->
      let
        detached = detachNode nodeId target
        copiedNode = node { childIds = filterArray (\childId -> notBoolean (nodeIdInArray childId movedNodeIds)) node.childIds }
      in
        case findNode nodeId detached of
          Nothing -> addNode detached copiedNode
          Just _ -> replaceNode detached copiedNode

closeHistoryOutlineWindowsMissingFromRuntime :: Array RuntimeWindow -> Outline -> Outline
closeHistoryOutlineWindowsMissingFromRuntime runtimeWindows outline =
  foldlArray (\current node ->
    case node.liveWindowId of
      Just windowId ->
        if andBoolean (isLiveWindowNode node) (notBoolean (anyArray (\window -> windowIdEq window.id windowId) runtimeWindows)) then
          let
            promoted = promoteForeignLiveWindowsAfterClosingWindow node.id windowId current
            promotedNode = findNode node.id promoted
            removeEmpty = case node.runtimeProvenance of
              Just provenance -> orBoolean (eqString provenance "commandCreated") (eqString provenance "browserCreated")
              Nothing -> false
          in
            case promotedNode of
              Just candidate ->
                if andBoolean removeEmpty (eqInt (lengthArray candidate.childIds) 0) then removeSingleNode node.id promoted
                else markClosedSubtreeById node.id 0 promoted
              Nothing -> promoted
        else current
      Nothing -> current) outline outline.nodes

alignHistoryRuntimeWindowProvenance :: Outline -> Outline -> Outline
alignHistoryRuntimeWindowProvenance currentOutline outline =
  outline { nodes = mapArray (\node ->
    if isLiveWindowNode node then
      case node.liveWindowId of
        Nothing -> node
        Just windowId ->
          case currentRuntimeWindowProvenance currentOutline windowId of
            Nothing -> node
            Just provenance -> node { runtimeProvenance = Just provenance }
    else node) outline.nodes }

currentRuntimeWindowProvenance :: Outline -> WindowId -> Maybe String
currentRuntimeWindowProvenance outline windowId =
  case findArray (\node ->
    case node.liveWindowId of
      Nothing -> false
      Just candidateWindowId -> andBoolean (isLiveWindowNode node) (windowIdEq candidateWindowId windowId)) outline.nodes of
    Nothing -> Nothing
    Just node -> node.runtimeProvenance

applyConcurrentCreatedTabThenGroup :: Int -> ConcurrentCreatedTabThenGroupAction -> OracleModel -> Result OracleModel
applyConcurrentCreatedTabThenGroup step details model =
  bindResult (resolveTabSelector step details.groupTab model) (\groupTab ->
    let
      groupNodeId = liveTabNodeIdForRuntimeTab groupTab.id model.outline
      createdTab = commandRelocationAdjustedCreatedTab groupNodeId details.createdTab model
      sourceWindowNodeId = liveWindowNodeIdForRuntimeWindow groupTab.windowId model.outline
      sourceWasCommandVisibleEmpty =
        andBoolean
          (windowIdEq createdTab.windowId groupTab.windowId)
          (sourceWindowWouldBeEmptiedByMovingNode sourceWindowNodeId groupNodeId model.outline)
    in
      case nonCanonicalCommandWindowSource groupNodeId createdTab.windowId model.outline of
        Just source -> applyConcurrentCreatedTabThenGroupFromNonCanonicalSource details groupTab groupNodeId createdTab source model
        Nothing ->
          let
            runtimeTabsWithCreated = createRuntimeTab model.runtimeTabs createdTab
            existingTabsBeforeCommand = filterArray (\candidate -> notBoolean (tabIdEq candidate.id createdTab.id)) (tabsInWindowFrom runtimeTabsWithCreated createdTab.windowId)
            outlineWithCreatedBeforeCommand = addLiveTabToOutlineWithExistingTabs model.outline model.now createdTab existingTabsBeforeCommand
            modelWithCreatedBeforeCommand =
              model
                { runtimeTabs = runtimeTabsWithCreated
                , outline = if createdTab.active then setActiveTabInOutlineWindow createdTab.windowId createdTab.id outlineWithCreatedBeforeCommand else outlineWithCreatedBeforeCommand
                , nextTabId = maxInt model.nextTabId (addInt (tabIdInt createdTab.id) 1)
                , lastOpenedTabId = Just createdTab.id
                }
          in
            if notBoolean sourceWasCommandVisibleEmpty then
              bindResult (applyOutlinerRelocation step details.groupTab true details.windowId modelWithCreatedBeforeCommand) (\moved ->
                Ok moved { outline = refreshOutlineDirectLiveTabOrderFromRuntime moved.runtimeTabs moved.outline })
            else
              let
                runtimeWindowsWithCreated = removeEmptyRuntimeWindows runtimeTabsWithCreated (ensureRuntimeWindowForTab createdTab model.runtimeWindows)
                sourceProvenance = currentRuntimeWindowProvenance model.outline createdTab.windowId
                modelWithCreatedRuntime =
                  model
                    { runtimeTabs = runtimeTabsWithCreated
                    , runtimeWindows = runtimeWindowsWithCreated
                    , nextTabId = maxInt model.nextTabId (addInt (tabIdInt createdTab.id) 1)
                    , lastOpenedTabId = Just createdTab.id
                    }
              in
                bindResult (applyOutlinerRelocation step details.groupTab true details.windowId modelWithCreatedRuntime) (\moved ->
                  let
                    runtimeTabs = moved.runtimeTabs
                    runtimeWindows = moved.runtimeWindows
                    createdWindow = runtimeWindowForId createdTab.windowId runtimeWindows
                    outlineAfterCommand = closeMissingOutlineWindow sourceWindowNodeId createdTab.windowId moved.outline
                    outlineWithCreatedWindow = addLiveWindowToOutlineIfRuntimeMissing outlineAfterCommand model.now createdWindow sourceProvenance
                    existingTabs = filterArray (\candidate -> notBoolean (tabIdEq candidate.id createdTab.id)) (tabsInWindowFrom runtimeTabs createdTab.windowId)
                    outlineWithCreatedTab = addLiveTabToOutlineWithExistingTabs outlineWithCreatedWindow model.now createdTab existingTabs
                    outlineWithCreatedActive = if createdTab.active then setActiveTabInOutlineWindow createdTab.windowId createdTab.id outlineWithCreatedTab else outlineWithCreatedTab
                    outline = syncTabActiveFlagsFromRuntime runtimeTabs outlineWithCreatedActive
                  in
                    Ok moved
                      { runtimeTabs = runtimeTabs
                      , runtimeWindows = runtimeWindows
                      , outline = outline
                      , lastOpenedTabId = Just createdTab.id
                      }))

sourceWindowWouldBeEmptiedByMovingNode :: NodeId -> NodeId -> Outline -> Boolean
sourceWindowWouldBeEmptiedByMovingNode sourceWindowNodeId movingNodeId outline =
  case findNode sourceWindowNodeId outline of
    Nothing -> false
    Just _ ->
      let
        sourceTabIds = liveTabIdsInSubtreeExcludingNestedLiveWindows sourceWindowNodeId outline
        movingTabIds = liveTabIdsInSubtreeExcludingNestedLiveWindows movingNodeId outline
      in
        andBoolean
          (notBoolean (eqInt (lengthArray sourceTabIds) 0))
          (allTabIdsInArray sourceTabIds movingTabIds)

allTabIdsInArray :: Array TabId -> Array TabId -> Boolean
allTabIdsInArray values candidates =
  foldlArray
    (\matched value -> andBoolean matched (anyArray (\candidate -> tabIdEq candidate value) candidates))
    true
    values

applyConcurrentCreatedTabThenGroupFromNonCanonicalSource ::
  ConcurrentCreatedTabThenGroupAction ->
  RuntimeTab ->
  NodeId ->
  RuntimeTab ->
  OutlineNode ->
  OracleModel ->
  Result OracleModel
applyConcurrentCreatedTabThenGroupFromNonCanonicalSource details groupTab groupNodeId createdTab source model =
  let
    newWindowId = maybe (WindowId model.nextWindowId) identityWindowId details.windowId
    newWindow = { id: newWindowId, focused: true, incognito: false, state: Nothing }
    runtimeWindowsWithNew = snocArray (mapArray (\candidate -> candidate { focused = false }) model.runtimeWindows) newWindow
    runtimeTabsWithCreated = createRuntimeTab model.runtimeTabs createdTab
    movedRuntimeTabs = moveRuntimeTabSubtree groupNodeId groupTab.id newWindowId 0 model.outline runtimeTabsWithCreated
    activeRuntimeTabs = applyCommandMoveActiveState groupTab.id groupTab.active movedRuntimeTabs
    runtimeTabs = reindexAllRuntimeTabs activeRuntimeTabs
    runtimeWindows = removeEmptyRuntimeWindows runtimeTabs runtimeWindowsWithNew
    canonicalWindow = runtimeWindowForId createdTab.windowId runtimeWindows
    canonicalWindowNodeId = windowNodeId createdTab.windowId
    withCanonicalWindow = addLiveWindowToOutline model.outline model.now canonicalWindow (Just "commandCreated")
    existingTabs = filterArray (\candidate -> notBoolean (tabIdEq candidate.id createdTab.id)) (tabsInWindowFrom runtimeTabs createdTab.windowId)
    withCreated = addLiveTabToOutlineUnderParent withCanonicalWindow model.now canonicalWindowNodeId createdTab existingTabs
    sourceIndex = indexOfNodeId source.id withCreated.rootIds
    withoutGroup = detachNode groupNodeId withCreated
    wrapper =
      { id: windowNodeId newWindowId
      , kind: WindowKind
      , status: LiveStatus
      , parentId: Nothing
      , childIds: [groupNodeId]
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
      , restoreClosedBy: Nothing
      , runtimeProvenance: Just "commandCreated"
      , restoredFromClosed: false
      }
    withWrapperNode = addNode withoutGroup wrapper
    withWrapper = withWrapperNode { rootIds = insertNodeIdAt wrapper.id (addInt sourceIndex 1) withWrapperNode.rootIds }
    withGroupParent = replaceNode withWrapper ((requireNodeOr groupNodeId withWrapper (emptyTabNode groupNodeId)) { parentId = Just wrapper.id })
    withRefs = updateLiveTabWindowRefForSubtree groupNodeId newWindowId withGroupParent
    withClosedSource = markClosedSubtreeById source.id model.now withRefs
    outlineWithActiveTabs = syncTabActiveFlagsFromRuntime runtimeTabs withClosedSource
    finalOutline = closeOutlineWindowsMissingFromRuntime runtimeWindows (setActiveWindowInOutlineIfFocused runtimeWindows outlineWithActiveTabs)
  in
    Ok model
      { runtimeTabs = runtimeTabs
      , runtimeWindows = runtimeWindows
      , outline = finalOutline
      , nextWindowId = maxInt model.nextWindowId (addInt (windowIdInt newWindowId) 1)
      , nextTabId = maxInt model.nextTabId (addInt (tabIdInt createdTab.id) 1)
      , lastOpenedTabId = Just createdTab.id
      , lastMovedTabId = Just groupTab.id
      , lastOpenedWindowId = Just newWindowId
      }

nonCanonicalCommandWindowSource :: NodeId -> WindowId -> Outline -> Maybe OutlineNode
nonCanonicalCommandWindowSource groupNodeId runtimeWindowId outline =
  case findNode groupNodeId outline of
    Nothing -> Nothing
    Just node ->
      case node.parentId of
        Nothing -> Nothing
        Just sourceNodeId ->
          case findNode sourceNodeId outline of
            Nothing -> Nothing
            Just source ->
              case source.liveWindowId of
                Nothing -> Nothing
                Just liveWindowId ->
                  let
                    commandCreated = case source.runtimeProvenance of
                      Just provenance -> eqString provenance "commandCreated"
                      Nothing -> false
                  in
                    if andBoolean
                      (andBoolean (isLiveWindowNode source) commandCreated)
                      (andBoolean
                        (andBoolean (windowIdEq liveWindowId runtimeWindowId) (notBoolean (nodeIdEq source.id (windowNodeId runtimeWindowId))))
                        (hasClosedDirectChild source.id outline))
                    then Just source
                    else Nothing

commandRelocationAdjustedCreatedTab :: NodeId -> RuntimeTab -> OracleModel -> RuntimeTab
commandRelocationAdjustedCreatedTab groupNodeId createdTab model =
  let
    movedSourceCount = lengthArray
      (filterArray
        (\tabId ->
          case findArray (\tab -> tabIdEq tab.id tabId) model.runtimeTabs of
            Nothing -> false
            Just tab -> andBoolean
              (windowIdEq tab.windowId createdTab.windowId)
              (lessThanInt tab.index createdTab.index))
        (liveTabIdsInSubtreeExcludingNestedLiveWindows groupNodeId model.outline))
    adjustedIndex = maxInt 0 (subInt createdTab.index movedSourceCount)
  in
    if eqInt adjustedIndex createdTab.index then createdTab else createdTab { index = adjustedIndex }

applyConcurrentUpdatedTabThenGroup :: Int -> ConcurrentUpdatedTabThenGroupAction -> OracleModel -> Result OracleModel
applyConcurrentUpdatedTabThenGroup step details model =
  let
    withUpdated = model
      { runtimeTabs = replaceRuntimeTab details.updatedTab model.runtimeTabs
      , outline = updateLiveTabMetadata details.updatedTab model.outline
      }
  in
    applyOutlinerRelocation step details.groupTab true details.windowId withUpdated

applyConcurrentActivatedTabThenGroup :: Int -> ConcurrentActivatedTabThenGroupAction -> OracleModel -> Result OracleModel
applyConcurrentActivatedTabThenGroup step details model =
  bindResult (resolveTabSelector step details.activatedTab model) (\tab ->
    let
      withActivated = model
        { runtimeTabs = setRuntimeActiveTab tab.id tab.windowId model.runtimeTabs
        , outline = setActiveTabInOutlineWindow tab.windowId tab.id model.outline
        }
    in
      applyOutlinerRelocation step details.groupTab true details.windowId withActivated)

applyConcurrentFocusedWindowThenGroup :: Int -> ConcurrentFocusedWindowThenGroupAction -> OracleModel -> Result OracleModel
applyConcurrentFocusedWindowThenGroup step details model =
  bindResult (resolveWindowSelector step details.focusedWindow model) (\window ->
    let
      withFocused = model
        { runtimeWindows = mapArray (\candidate -> candidate { focused = windowIdEq candidate.id window.id }) model.runtimeWindows
        , outline = setActiveWindowInOutline window.id model.outline
        }
    in
      applyOutlinerRelocation step details.groupTab true details.windowId withFocused)

appendRestoredRuntimeWindows :: Array RuntimeWindow -> Array RuntimeWindow -> Array RuntimeWindow
appendRestoredRuntimeWindows restored existing =
  appendArray
    (filterArray (\window -> notBoolean (anyArray (\restoredWindow -> windowIdEq restoredWindow.id window.id) restored)) existing)
    restored

clearRuntimeWindowFocusIfRestoredFocused :: Array RuntimeWindow -> Array RuntimeWindow -> Array RuntimeWindow
clearRuntimeWindowFocusIfRestoredFocused restored existing =
  if anyArray (\window -> window.focused) restored then mapArray (\window -> window { focused = false }) existing
  else existing

appendRestoredRuntimeTabs :: Array RuntimeTab -> Array RuntimeTab -> Array RuntimeTab
appendRestoredRuntimeTabs restored existing =
  appendArray
    (filterArray (\tab -> notBoolean (anyArray (\restoredTab -> tabIdEq restoredTab.id tab.id) restored)) existing)
    restored

restoredWindowsForRestoredTab :: RuntimeTab -> Array RuntimeWindow -> Array RuntimeWindow -> Array RuntimeWindow
restoredWindowsForRestoredTab tab restoredWindows existingWindows =
  if anyArray (\window -> windowIdEq window.id tab.windowId) restoredWindows then restoredWindows
  else if anyArray (\window -> windowIdEq window.id tab.windowId) existingWindows then restoredWindows
  else snocArray restoredWindows { id: tab.windowId, focused: tab.active, incognito: false, state: Nothing }

restoreClosedWindowSubtree :: NodeId -> Array RuntimeWindow -> Array RuntimeTab -> Outline -> Outline
restoreClosedWindowSubtree nodeId restoredWindows restoredTabs outline =
  let
    closedWindowNodeIds = closedWindowNodeIdsInSubtree nodeId outline
    closedTabNodeIds = closedTabNodeIdsInSubtree nodeId outline
    restoredOutline =
      outline { nodes = mapArray (\node ->
        case restoredWindowForNode node.id closedWindowNodeIds restoredWindows of
          Just window -> restoreWindowOutlineNode node window
          Nothing ->
            case restoredTabForNode node.id closedTabNodeIds restoredTabs of
              Nothing -> node
              Just tab -> restoreTabOutlineNode node tab) outline.nodes }
  in
    promoteRestoredLiveNodesOutOfClosedAncestors [nodeId] restoredOutline

restoreClosedTabNode :: NodeId -> RuntimeTab -> Array RuntimeWindow -> Outline -> Outline
restoreClosedTabNode nodeId tab restoredWindows outline =
  let
    node = requireNodeOr nodeId outline (emptyTabNode nodeId)
  in
    case node.parentId of
      Just parentId ->
        case findNode parentId outline of
          Just parent ->
            if andBoolean (isClosedCommandCreatedWindowNode parent) (notBoolean (eqInt (lengthArray restoredWindows) 0)) then
              let
                window = runtimeWindowForId tab.windowId restoredWindows
                withParent = replaceNode outline (restoreWindowOutlineNode parent window)
                withTab = replaceNode withParent (restoreTabOutlineNode node tab)
              in
                withTab
            else promoteRestoredLiveNodesOutOfClosedAncestors [nodeId] (replaceNode outline (restoreTabOutlineNode node tab))
          Nothing -> promoteRestoredLiveNodesOutOfClosedAncestors [nodeId] (replaceNode outline (restoreTabOutlineNode node tab))
      Nothing ->
        case emptyClosedCommandCreatedWindow restoredWindows outline of
          Just parent ->
            let
              window = runtimeWindowForId tab.windowId restoredWindows
              withParent = replaceNode outline (restoreWindowOutlineNode parent window)
              withTabRootRemoved = withParent { rootIds = removeNodeId node.id withParent.rootIds }
              withTab = replaceNode withTabRootRemoved ((restoreTabOutlineNode node tab) { parentId = Just parent.id })
            in
              replaceNode withTab ((requireNodeOr parent.id withTab (emptyTabNode parent.id)) { childIds = [node.id] })
          Nothing -> promoteRestoredLiveNodesOutOfClosedAncestors [nodeId] (replaceNode outline (restoreTabOutlineNode node tab))

isClosedCommandCreatedWindowNode :: OutlineNode -> Boolean
isClosedCommandCreatedWindowNode node =
  case node.runtimeProvenance of
    Just provenance ->
      case node.kind of
        WindowKind ->
          case node.status of
            ClosedStatus -> eqString provenance "commandCreated"
            LiveStatus -> false
            NeutralStatus -> false
        TabKind -> false
        GroupKind -> false
    Nothing -> false

emptyClosedCommandCreatedWindow :: Array RuntimeWindow -> Outline -> Maybe OutlineNode
emptyClosedCommandCreatedWindow restoredWindows outline =
  if eqInt (lengthArray restoredWindows) 0 then Nothing
  else findArray (\node -> andBoolean (isClosedCommandCreatedWindowNode node) (eqInt (lengthArray node.childIds) 0)) outline.nodes

promoteRestoredLiveNodesOutOfClosedAncestors :: Array NodeId -> Outline -> Outline
promoteRestoredLiveNodesOutOfClosedAncestors nodeIds outline =
  foldlArray
    (\current nodeId -> promoteLiveNodeOutOfClosedAncestors nodeId current)
    outline
    (uniqueRestoredLiveRootsUnderClosedAncestors nodeIds outline)

uniqueRestoredLiveRootsUnderClosedAncestors :: Array NodeId -> Outline -> Array NodeId
uniqueRestoredLiveRootsUnderClosedAncestors nodeIds outline =
  foldlArray
    (\roots nodeId ->
      case liveRootUnderClosedAncestor nodeId outline of
        Nothing -> roots
        Just rootId ->
          if anyArray (\candidateId -> nodeIdEq candidateId rootId) roots then roots
          else snocArray roots rootId)
    []
    nodeIds

liveRootUnderClosedAncestor :: NodeId -> Outline -> Maybe NodeId
liveRootUnderClosedAncestor nodeId outline =
  liveRootUnderClosedAncestorLoop nodeId Nothing [] outline

liveRootUnderClosedAncestorLoop :: NodeId -> Maybe NodeId -> Array NodeId -> Outline -> Maybe NodeId
liveRootUnderClosedAncestorLoop nodeId candidateId visited outline =
  if anyArray (\visitedId -> nodeIdEq visitedId nodeId) visited then candidateId
  else
    case findNode nodeId outline of
      Nothing -> candidateId
      Just node ->
        let
          nextCandidateId = case node.parentId of
            Nothing -> candidateId
            Just parentId ->
              case findNode parentId outline of
                Nothing -> candidateId
                Just parent ->
                  if andBoolean (isLiveStatus node.status) (isClosedStatus parent.status) then Just node.id
                  else candidateId
        in
          case node.parentId of
            Nothing -> nextCandidateId
            Just parentId -> liveRootUnderClosedAncestorLoop parentId nextCandidateId (snocArray visited node.id) outline

promoteLiveNodeOutOfClosedAncestors :: NodeId -> Outline -> Outline
promoteLiveNodeOutOfClosedAncestors nodeId outline =
  case findNode nodeId outline of
    Nothing -> outline
    Just node ->
      case node.parentId of
        Nothing -> outline
        Just parentId ->
          case findNode parentId outline of
            Nothing -> outline
            Just parent ->
              if notBoolean (isClosedStatus parent.status) then outline
              else
                let
                  topClosedAncestor = topClosedAncestorFrom parent [] outline
                  targetParentId = nonClosedParentId topClosedAncestor outline
                  insertionIndex = case targetParentId of
                    Nothing -> addInt (indexOfNodeId topClosedAncestor.id outline.rootIds) 1
                    Just targetId -> addInt (indexOfNodeId topClosedAncestor.id (requireNodeOr targetId outline (emptyTabNode targetId)).childIds) 1
                  detached = detachNode nodeId outline
                  withParent = replaceNode detached ((requireNodeOr nodeId detached (emptyTabNode nodeId)) { parentId = targetParentId })
                in
                  case targetParentId of
                    Nothing -> withParent { rootIds = insertNodeIdAt nodeId insertionIndex withParent.rootIds }
                    Just targetId ->
                      replaceNode withParent
                        ((requireNodeOr targetId withParent (emptyTabNode targetId))
                          { childIds = insertNodeIdAt nodeId insertionIndex (requireNodeOr targetId withParent (emptyTabNode targetId)).childIds })

topClosedAncestorFrom :: OutlineNode -> Array NodeId -> Outline -> OutlineNode
topClosedAncestorFrom node visited outline =
  if anyArray (\visitedId -> nodeIdEq visitedId node.id) visited then node
  else
    case node.parentId of
      Nothing -> node
      Just parentId ->
        case findNode parentId outline of
          Just parent ->
            if isClosedStatus parent.status then topClosedAncestorFrom parent (snocArray visited node.id) outline
            else node
          Nothing -> node

nonClosedParentId :: OutlineNode -> Outline -> Maybe NodeId
nonClosedParentId node outline =
  case node.parentId of
    Nothing -> Nothing
    Just parentId ->
      case findNode parentId outline of
        Just parent -> if isClosedStatus parent.status then Nothing else Just parentId
        Nothing -> Nothing

restoreWindowOutlineNode :: OutlineNode -> RuntimeWindow -> OutlineNode
restoreWindowOutlineNode node window =
  node
    { status = LiveStatus
    , active = Just window.focused
    , liveWindowId = Just window.id
    , liveTabId = Nothing
    , restoreSessionId = Nothing
    , restoreUrl = Nothing
    , restoreTitle = Nothing
    , restoreFavIconUrl = Nothing
    , restoreClosedBy = Nothing
    , runtimeProvenance = Just "commandCreated"
    , restoredFromClosed = true
    }

restoreTabOutlineNode :: OutlineNode -> RuntimeTab -> OutlineNode
restoreTabOutlineNode node tab =
  node
    { status = LiveStatus
    , active = Just tab.active
    , liveWindowId = Just tab.windowId
    , liveTabId = Just tab.id
    , url = tab.url
    , title = node.title
    , favIconUrl = tab.favIconUrl
    , restoreSessionId = Nothing
    , restoreUrl = Nothing
    , restoreTitle = Nothing
    , restoreFavIconUrl = Nothing
    , restoreClosedBy = Nothing
    , restoredFromClosed = true
    }

closedTabNodeIdsInSubtree :: NodeId -> Outline -> Array NodeId
closedTabNodeIdsInSubtree nodeId outline =
  mapMaybeArray (\candidateId ->
    case findNode candidateId outline of
      Just node ->
        case node.kind of
          TabKind -> Just candidateId
          WindowKind -> Nothing
          GroupKind -> Nothing
      Nothing -> Nothing) (subtreeNodeIds nodeId outline)

closedWindowNodeIdsInSubtree :: NodeId -> Outline -> Array NodeId
closedWindowNodeIdsInSubtree nodeId outline =
  mapMaybeArray (\candidateId ->
    case findNode candidateId outline of
      Just node ->
        case node.kind of
          WindowKind -> if isClosedStatus node.status then Just candidateId else Nothing
          TabKind -> Nothing
          GroupKind -> Nothing
      Nothing -> Nothing) (subtreeNodeIds nodeId outline)

restoredWindowForNode :: NodeId -> Array NodeId -> Array RuntimeWindow -> Maybe RuntimeWindow
restoredWindowForNode nodeId windowNodeIds restoredWindows =
  case findIndexArray (\candidateId -> nodeIdEq candidateId nodeId) windowNodeIds of
    Nothing -> Nothing
    Just index -> indexArray index restoredWindows

restoredTabForNode :: NodeId -> Array NodeId -> Array RuntimeTab -> Maybe RuntimeTab
restoredTabForNode nodeId tabNodeIds restoredTabs =
  case findIndexArray (\candidateId -> nodeIdEq candidateId nodeId) tabNodeIds of
    Nothing -> Nothing
    Just index -> indexArray index restoredTabs

setRestoredCaptures :: RestoreNodeAction -> OracleModel -> OracleModel
setRestoredCaptures details model =
  let
    withTabs = setTabsCapture details.captureRestoredTabs details.restoredTabs model
  in
    case indexArray 0 details.restoredWindows of
      Nothing -> withTabs
      Just window -> setWindowCapture details.captureRestoredWindows window.id withTabs

firstRuntimeTabId :: Array RuntimeTab -> Maybe TabId -> Maybe TabId
firstRuntimeTabId tabs fallback =
  case indexArray 0 tabs of
    Nothing -> fallback
    Just tab -> Just tab.id

firstRuntimeWindowId :: Array RuntimeWindow -> Maybe WindowId -> Maybe WindowId
firstRuntimeWindowId windows fallback =
  case indexArray 0 windows of
    Nothing -> fallback
    Just window -> Just window.id

addLiveWindowToOutline :: Outline -> Int -> RuntimeWindow -> Maybe String -> Outline
addLiveWindowToOutline outline _now window provenance =
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
          , restoreClosedBy: Nothing
          , runtimeProvenance: provenance
          , restoredFromClosed: false
          }

addLiveWindowToOutlineIfRuntimeMissing :: Outline -> Int -> RuntimeWindow -> Maybe String -> Outline
addLiveWindowToOutlineIfRuntimeMissing outline now window provenance =
  case findNode (liveWindowNodeIdForRuntimeWindow window.id outline) outline of
    Just _ -> outline
    Nothing -> addLiveWindowToOutline outline now window provenance

addLiveTabToOutline :: Outline -> Int -> RuntimeTab -> Outline
addLiveTabToOutline outline now tab =
  addLiveTabToOutlineWithExistingTabs outline now tab []

addLiveTabToOutlineWithExistingTabs :: Outline -> Int -> RuntimeTab -> Array RuntimeTab -> Outline
addLiveTabToOutlineWithExistingTabs outline now tab existingTabs =
  let
    parentId = parentForNewRuntimeTab outline tab
    nodeId = tabNodeId tab.id
    node = (tabToNode now parentId tab) { parentId = Just parentId }
    withNode = addNode outline node
  in
    if shouldAppendBlankTabAfterCommandCreatedClosedChildren parentId tab withNode then
      appendChild parentId nodeId withNode
    else
      insertLiveTabChildWithCreateBoundaries parentId nodeId tab existingTabs withNode

addLiveTabToOutlineUnderParent :: Outline -> Int -> NodeId -> RuntimeTab -> Array RuntimeTab -> Outline
addLiveTabToOutlineUnderParent outline now parentId tab existingTabs =
  let
    nodeId = tabNodeId tab.id
    node = (tabToNode now parentId tab) { parentId = Just parentId }
    withNode = addNode outline node
  in
    if shouldAppendBlankTabAfterCommandCreatedClosedChildren parentId tab withNode then
      appendChild parentId nodeId withNode
    else
      insertLiveTabChildWithCreateBoundaries parentId nodeId tab existingTabs withNode

hasClosedDirectChild :: NodeId -> Outline -> Boolean
hasClosedDirectChild parentId outline =
  case findNode parentId outline of
    Nothing -> false
    Just parent ->
      anyArray
        (\childId -> case findNode childId outline of
          Just child -> case child.status of
            ClosedStatus -> true
            LiveStatus -> false
            NeutralStatus -> false
          Nothing -> false)
        parent.childIds

shouldAppendBlankTabAfterCommandCreatedClosedChildren :: NodeId -> RuntimeTab -> Outline -> Boolean
shouldAppendBlankTabAfterCommandCreatedClosedChildren parentId tab outline =
  andBoolean
    (andBoolean (isBlankRuntimeTabUrl tab.url) (isCommandCreatedNode parentId outline))
    (hasClosedDirectChild parentId outline)

isCommandCreatedNode :: NodeId -> Outline -> Boolean
isCommandCreatedNode nodeId outline =
  case findNode nodeId outline of
    Nothing -> false
    Just node ->
      case node.runtimeProvenance of
        Just provenance -> eqString provenance "commandCreated"
        Nothing -> false

insertLiveTabChildWithCreateBoundaries :: NodeId -> NodeId -> RuntimeTab -> Array RuntimeTab -> Outline -> Outline
insertLiveTabChildWithCreateBoundaries parentId nodeId tab existingTabs outline =
  case blankOpenerNestedWindowBoundaryIndex parentId tab existingTabs outline of
    Just boundaryIndex -> insertChildAt parentId nodeId (addInt boundaryIndex 1) outline
    Nothing -> insertLiveTabChildInRuntimeOrder parentId nodeId tab existingTabs outline

blankOpenerNestedWindowBoundaryIndex :: NodeId -> RuntimeTab -> Array RuntimeTab -> Outline -> Maybe Int
blankOpenerNestedWindowBoundaryIndex parentId tab existingTabs outline =
  if notBoolean (isBlankRuntimeTabUrl tab.url) then Nothing
  else case tab.openerTabId of
    Nothing -> Nothing
    Just openerTabId ->
      let openerNodeId = liveTabNodeIdForRuntimeTab openerTabId outline in
        case directChildAncestorUnderParent openerNodeId parentId outline of
          Nothing -> Nothing
          Just openerChildId ->
            if notBoolean (hasClosedDescendant openerChildId outline) then Nothing
            else case minimumRuntimeRankInSubtree openerChildId tab.windowId existingTabs outline of
              Nothing -> Nothing
              Just openerRank ->
                if lessThanInt openerRank tab.index then Nothing
                else contiguousNestedLiveWindowBoundaryIndexAfter parentId openerChildId outline

directChildAncestorUnderParent :: NodeId -> NodeId -> Outline -> Maybe NodeId
directChildAncestorUnderParent nodeId parentId outline =
  directChildAncestorUnderParentLoop nodeId parentId [] outline

directChildAncestorUnderParentLoop :: NodeId -> NodeId -> Array NodeId -> Outline -> Maybe NodeId
directChildAncestorUnderParentLoop nodeId parentId visited outline =
  if anyArray (\visitedId -> nodeIdEq visitedId nodeId) visited then Nothing
  else case findNode nodeId outline of
    Nothing -> Nothing
    Just node ->
      case node.parentId of
        Nothing -> Nothing
        Just candidateParentId ->
          if nodeIdEq candidateParentId parentId then Just node.id
          else directChildAncestorUnderParentLoop candidateParentId parentId (snocArray visited node.id) outline

hasClosedDescendant :: NodeId -> Outline -> Boolean
hasClosedDescendant nodeId outline =
  anyArray
    (\candidateId ->
      if nodeIdEq candidateId nodeId then false
      else case findNode candidateId outline of
        Just candidate -> isClosedStatus candidate.status
        Nothing -> false)
    (subtreeNodeIds nodeId outline)

contiguousNestedLiveWindowBoundaryIndexAfter :: NodeId -> NodeId -> Outline -> Maybe Int
contiguousNestedLiveWindowBoundaryIndexAfter parentId openerChildId outline =
  let
    parent = requireNodeOr parentId outline (emptyTabNode parentId)
    state = foldlWithIndexArray
      (\index current childId ->
        if notBoolean current.seenOpener then
          if nodeIdEq childId openerChildId then current { seenOpener = true, scanning = true }
          else current
        else if notBoolean current.scanning then current
        else case findNode childId outline of
          Just child ->
            if isLiveWindowNode child then current { boundaryIndex = Just index }
            else current { scanning = false }
          Nothing -> current { scanning = false })
      { seenOpener: false, scanning: false, boundaryIndex: Nothing }
      parent.childIds
  in
    state.boundaryIndex

insertLiveTabChildInRuntimeOrder :: NodeId -> NodeId -> RuntimeTab -> Array RuntimeTab -> Outline -> Outline
insertLiveTabChildInRuntimeOrder parentId nodeId tab existingTabs outline =
  case nextRuntimeTabInParent parentId tab existingTabs outline of
    Just nextTab -> insertChildBefore parentId nodeId (liveTabNodeIdForRuntimeTab nextTab.id outline) outline
    Nothing -> appendChild parentId nodeId outline

nextRuntimeTabInParent :: NodeId -> RuntimeTab -> Array RuntimeTab -> Outline -> Maybe RuntimeTab
nextRuntimeTabInParent parentId tab existingTabs outline =
  case indexArray 0
    (filterArray
      (\candidate ->
        andBoolean
          (runtimeTabBelongsToParent parentId candidate outline)
          (notBoolean (lessThanInt (runtimeTabRankInParent parentId candidate existingTabs outline) tab.index)))
      existingTabs) of
    Nothing -> Nothing
    Just next -> Just next

runtimeTabRankInParent :: NodeId -> RuntimeTab -> Array RuntimeTab -> Outline -> Int
runtimeTabRankInParent parentId tab tabs outline =
  case findNode (liveTabNodeIdForRuntimeTab tab.id outline) outline of
    Nothing -> tab.index
    Just node ->
      case node.parentId of
        Just candidateParentId ->
          if nodeIdEq candidateParentId parentId then
            maybe tab.index identityInt (minimumRuntimeRankInSubtree node.id tab.windowId tabs outline)
          else tab.index
        Nothing -> tab.index

runtimeTabBelongsToParent :: NodeId -> RuntimeTab -> Outline -> Boolean
runtimeTabBelongsToParent parentId tab outline =
  case findNode (liveTabNodeIdForRuntimeTab tab.id outline) outline of
    Nothing -> false
    Just node ->
      case node.parentId of
        Nothing -> false
        Just candidateParentId -> nodeIdEq candidateParentId parentId

parentForNewRuntimeTab :: Outline -> RuntimeTab -> NodeId
parentForNewRuntimeTab outline tab =
  let fallbackWindowNodeId = liveWindowNodeIdForRuntimeWindow tab.windowId outline in
  case tab.openerTabId of
    Just openerId ->
      if isBlankRuntimeTabUrl tab.url then fallbackWindowNodeId
      else
        let openerNodeId = liveTabNodeIdForRuntimeTab openerId outline in
          case findNode openerNodeId outline of
            Just openerNode ->
              case openerNode.liveWindowId of
                Just openerWindowId -> if windowIdEq openerWindowId tab.windowId then openerNodeId else fallbackWindowNodeId
                Nothing -> fallbackWindowNodeId
            Nothing -> fallbackWindowNodeId
    Nothing -> fallbackWindowNodeId

wrapLiveTabInCommandWindow :: NodeId -> WindowId -> Int -> Outline -> Outline
wrapLiveTabInCommandWindow tabNode newWindowId _now outline =
  case commandWindowSourceForPromotedWrap tabNode newWindowId outline of
    Just source -> setActiveWindowInOutline newWindowId (wrapLiveTabInCommandWindowPromotingSource tabNode newWindowId source outline)
    Nothing ->
      let
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
                , restoreClosedBy: Nothing
                , runtimeProvenance: Just "commandCreated"
                , restoredFromClosed: false
                }
              insertionIndex = case node.parentId of
                Nothing -> indexOfNodeId node.id outline.rootIds
                Just parentId -> indexOfNodeId node.id (requireNodeOr parentId outline (emptyTabNode parentId)).childIds
              detached = detachNode tabNode outline
              withWrapperNode = addNode detached wrapper
              withWrapper = case node.parentId of
                Nothing -> withWrapperNode { rootIds = insertNodeIdAt wrapperId insertionIndex withWrapperNode.rootIds }
                Just parentId -> insertChildAt parentId wrapperId insertionIndex withWrapperNode
              withTab = replaceNode withWrapper (node { parentId = Just wrapperId })
            in setActiveWindowInOutline newWindowId withTab

type CommandWindowSource =
  { sourceNode :: OutlineNode
  , parentId :: Maybe NodeId
  , sourceIndex :: Int
  }

commandWindowSourceForPromotedWrap :: NodeId -> WindowId -> Outline -> Maybe CommandWindowSource
commandWindowSourceForPromotedWrap tabNode newWindowId outline =
  case findNode tabNode outline of
    Nothing -> Nothing
    Just node ->
      case node.parentId of
        Nothing -> Nothing
        Just sourceNodeId ->
          case findNode sourceNodeId outline of
            Nothing -> Nothing
            Just sourceNode ->
              case sourceNode.liveWindowId of
                Nothing -> Nothing
                Just sourceWindowId ->
                  let
                    commandCreated = case sourceNode.runtimeProvenance of
                      Just provenance -> eqString provenance "commandCreated"
                      Nothing -> false
                  in
                    if andBoolean
                      (andBoolean (isLiveWindowNode sourceNode) commandCreated)
                      (andBoolean
                        (andBoolean (notBoolean (windowIdEq sourceWindowId newWindowId)) (sourceCommandWindowParentIsLiveTab sourceNode outline))
                        (sourceCommandWindowHasOtherOwnedLiveTab sourceNode.id tabNode sourceWindowId outline))
                    then
                      let
                        sourceIndex = case sourceNode.parentId of
                          Nothing -> indexOfNodeId sourceNode.id outline.rootIds
                          Just parentId -> indexOfNodeId sourceNode.id (requireNodeOr parentId outline (emptyTabNode parentId)).childIds
                      in
                        Just { sourceNode: sourceNode, parentId: sourceNode.parentId, sourceIndex: sourceIndex }
                    else Nothing

sourceCommandWindowParentIsLiveTab :: OutlineNode -> Outline -> Boolean
sourceCommandWindowParentIsLiveTab node outline =
  case node.parentId of
    Nothing -> false
    Just parentId ->
      case findNode parentId outline of
        Nothing -> false
        Just parent -> isLiveTabNode parent

sourceCommandWindowHasOtherOwnedLiveTab :: NodeId -> NodeId -> WindowId -> Outline -> Boolean
sourceCommandWindowHasOtherOwnedLiveTab sourceNodeId movingNodeId sourceWindowId outline =
  let movingIds = subtreeNodeIdsExcludingNestedLiveWindows movingNodeId outline in
    anyArray
      (\nodeId ->
        if anyArray (\movingId -> nodeIdEq movingId nodeId) movingIds then false
        else
          case findNode nodeId outline of
            Nothing -> false
            Just node ->
              case node.liveWindowId of
                Just liveWindowId -> andBoolean (isLiveTabNode node) (windowIdEq liveWindowId sourceWindowId)
                Nothing -> false)
      (subtreeNodeIdsExcludingNestedLiveWindows sourceNodeId outline)

wrapLiveTabInCommandWindowPromotingSource :: NodeId -> WindowId -> CommandWindowSource -> Outline -> Outline
wrapLiveTabInCommandWindowPromotingSource tabNode newWindowId source outline =
  let
    wrapperId = windowNodeId newWindowId
    wrapper =
      { id: wrapperId
      , kind: WindowKind
      , status: LiveStatus
      , parentId: source.parentId
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
      , restoreClosedBy: Nothing
      , runtimeProvenance: Just "commandCreated"
      , restoredFromClosed: false
      }
    withoutTab = detachNode tabNode outline
    withoutSource = detachNode source.sourceNode.id withoutTab
    withSourceRoot =
      if anyArray (\rootId -> nodeIdEq rootId source.sourceNode.id) withoutSource.rootIds then withoutSource
      else withoutSource { rootIds = snocArray withoutSource.rootIds source.sourceNode.id }
    withWrapperNode = addNode withSourceRoot wrapper
    withWrapper = case source.parentId of
      Nothing -> withWrapperNode { rootIds = insertNodeIdAt wrapperId source.sourceIndex withWrapperNode.rootIds }
      Just parentId ->
        replaceNode withWrapperNode
          ((requireNodeOr parentId withWrapperNode (emptyTabNode parentId))
            { childIds = insertNodeIdAt wrapperId source.sourceIndex (requireNodeOr parentId withWrapperNode (emptyTabNode parentId)).childIds })
  in
    replaceNode withWrapper ((requireNodeOr tabNode withWrapper (emptyTabNode tabNode)) { parentId = Just wrapperId })

moveLiveTabToNewRootWindow :: NodeId -> WindowId -> Int -> Outline -> Outline
moveLiveTabToNewRootWindow tabNode newWindowId _now outline =
  let
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
      , restoreClosedBy: Nothing
      , runtimeProvenance: Just "commandCreated"
      , restoredFromClosed: false
      }
    detached = detachNode tabNode outline
    withWindow = { rootIds: [windowNode.id], nodes: snocArray detached.nodes windowNode }
    withRoots = withWindow { rootIds = appendArray withWindow.rootIds detached.rootIds }
  in
    replaceNode withRoots ((requireNodeOr tabNode outline (emptyTabNode tabNode)) { parentId = Just windowNode.id })

moveLiveTabToWindow :: NodeId -> WindowId -> Int -> Int -> Outline -> Outline
moveLiveTabToWindow tabNode targetWindowId targetIndex _now outline =
  let
    targetWindowNode = liveWindowNodeIdForRuntimeWindow targetWindowId outline
  in
    case findNode tabNode outline of
      Nothing -> outline
      Just node ->
        let
          detached = detachNode tabNode outline
          updated = node { parentId = Just targetWindowNode }
        in insertChildAt targetWindowNode tabNode targetIndex (replaceNode detached updated)

updateLiveTabWindowRefForSubtree :: NodeId -> WindowId -> Outline -> Outline
updateLiveTabWindowRefForSubtree nodeId windowId outline =
  let ids = subtreeNodeIdsExcludingNestedLiveWindows nodeId outline in
    outline { nodes = mapArray (\node ->
      if andBoolean (anyArray (\id -> nodeIdEq id node.id) ids) (isLiveTabNode node) then node { liveWindowId = Just windowId }
      else node) outline.nodes }

updateLiveTabWindowRefForNode :: NodeId -> WindowId -> Outline -> Outline
updateLiveTabWindowRefForNode nodeId windowId outline =
  case findNode nodeId outline of
    Just node -> if isLiveTabNode node then replaceNode outline (node { liveWindowId = Just windowId }) else outline
    Nothing -> outline

setActiveTabsInOutlineFromRuntime :: Array RuntimeTab -> Outline -> Outline
setActiveTabsInOutlineFromRuntime tabs outline =
  foldlArray
    (\current tab -> if tab.active then setActiveTabInOutlineWindow tab.windowId tab.id current else current)
    outline
    tabs

syncTabActiveFlagsFromRuntime :: Array RuntimeTab -> Outline -> Outline
syncTabActiveFlagsFromRuntime tabs outline =
  outline { nodes = mapArray (\node ->
    if isLiveTabNode node then
      case node.liveTabId of
        Nothing -> node
        Just liveTabId ->
          case findArray (\tab -> tabIdEq tab.id liveTabId) tabs of
            Nothing -> node
            Just tab -> node { active = Just tab.active }
    else node) outline.nodes }

promoteSourceWindowLiveChildrenBeforeMove :: NodeId -> WindowId -> Outline -> Outline
promoteSourceWindowLiveChildrenBeforeMove movingNodeId sourceWindowId outline =
  case findNode movingNodeId outline of
    Nothing -> outline
    Just movingNode ->
      let
        promotedChildIds = filterArray (\childId -> isLiveTabChildInWindow childId sourceWindowId outline) movingNode.childIds
      in
        if eqInt (lengthArray promotedChildIds) 0 then outline
        else
          let
            remainingChildIds = filterArray (\childId -> notBoolean (anyArray (\promotedId -> nodeIdEq promotedId childId) promotedChildIds)) movingNode.childIds
            movingIndex = case movingNode.parentId of
              Nothing -> indexOfNodeId movingNodeId outline.rootIds
              Just parentId -> indexOfNodeId movingNodeId (requireNodeOr parentId outline (emptyTabNode parentId)).childIds
            withMoving = replaceNode outline (movingNode { childIds = remainingChildIds })
            withPromotedParents = withMoving
              { nodes = mapArray (\node ->
                  if anyArray (\promotedId -> nodeIdEq promotedId node.id) promotedChildIds then node { parentId = movingNode.parentId }
                  else node) withMoving.nodes
              }
            insertionIndex = addInt movingIndex 1
          in
            case movingNode.parentId of
              Nothing -> withPromotedParents { rootIds = insertNodeIdsAt promotedChildIds insertionIndex withPromotedParents.rootIds }
              Just parentId ->
                replaceNode withPromotedParents
                  ((requireNodeOr parentId withPromotedParents (emptyTabNode parentId))
                    { childIds = insertNodeIdsAt promotedChildIds insertionIndex (requireNodeOr parentId withPromotedParents (emptyTabNode parentId)).childIds })

isLiveTabChildInWindow :: NodeId -> WindowId -> Outline -> Boolean
isLiveTabChildInWindow nodeId windowId outline =
  case findNode nodeId outline of
    Nothing -> false
    Just node ->
      if isLiveTabNode node then
        case node.liveWindowId of
          Just liveWindowId -> windowIdEq liveWindowId windowId
          Nothing -> false
      else false

markClosedNodeByIdWithSessionAndClosedBy :: NodeId -> Maybe String -> Maybe String -> Int -> Outline -> Outline
markClosedNodeByIdWithSessionAndClosedBy nodeId sessionId closedBy _now outline =
  let
    node = requireNodeOr nodeId outline (emptyTabNode nodeId)
    nextClosedBy = closeOwnerForNode closedBy node
  in
    replaceNode outline ((markClosed node) { restoreSessionId = sessionId, restoreClosedBy = nextClosedBy })

closeTabNodeByIdWithSessionAndClosedBy :: NodeId -> Maybe String -> Maybe String -> Int -> Outline -> Outline
closeTabNodeByIdWithSessionAndClosedBy nodeId sessionId closedBy now outline =
  promoteChildrenAfterNodeId nodeId (markClosedNodeByIdWithSessionAndClosedBy nodeId sessionId closedBy now outline)

promoteChildrenAfterNodeId :: NodeId -> Outline -> Outline
promoteChildrenAfterNodeId nodeId outline =
  case findNode nodeId outline of
    Nothing -> outline
    Just node ->
      let
        promotedChildIds = node.childIds
      in
        if eqInt (lengthArray promotedChildIds) 0 then outline
        else
          let
            insertionIndex = case node.parentId of
              Nothing -> addInt (indexOfNodeId node.id outline.rootIds) 1
              Just parentId -> addInt (indexOfNodeId node.id (requireNodeOr parentId outline (emptyTabNode parentId)).childIds) 1
            withNode = replaceNode outline (node { childIds = [] })
            withParents = withNode
              { nodes = mapArray (\candidate ->
                  if anyArray (\childId -> nodeIdEq childId candidate.id) promotedChildIds then candidate { parentId = node.parentId }
                  else candidate) withNode.nodes
              }
          in
            case node.parentId of
              Nothing -> withParents { rootIds = insertNodeIdsAt promotedChildIds insertionIndex withParents.rootIds }
              Just parentId ->
                replaceNode withParents
                  ((requireNodeOr parentId withParents (emptyTabNode parentId))
                    { childIds = insertNodeIdsAt promotedChildIds insertionIndex (requireNodeOr parentId withParents (emptyTabNode parentId)).childIds })

markClosedSubtreeById :: NodeId -> Int -> Outline -> Outline
markClosedSubtreeById nodeId now outline =
  markClosedSubtreeByIdWithClosedBy nodeId Nothing now outline

markClosedSubtreeByIdWithClosedBy :: NodeId -> Maybe String -> Int -> Outline -> Outline
markClosedSubtreeByIdWithClosedBy nodeId closedBy _now outline =
  let ids = subtreeNodeIds nodeId outline in
    outline { nodes = mapArray (\node -> if anyArray (\id -> nodeIdEq id node.id) ids then (markClosed node) { restoreClosedBy = closeOwnerForNode closedBy node } else node) outline.nodes }

closeOwnerForNode :: Maybe String -> OutlineNode -> Maybe String
closeOwnerForNode closedBy node =
  case closedBy of
    Just owner -> Just owner
    Nothing -> node.restoreClosedBy

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
    , restoredFromClosed = false
    }

promoteForeignLiveWindowsAfterClosingWindow :: NodeId -> WindowId -> Outline -> Outline
promoteForeignLiveWindowsAfterClosingWindow closingNodeId closingRuntimeWindowId outline =
  let foreignNodeIds = foreignLiveWindowRootsInSubtree closingNodeId closingRuntimeWindowId outline in
    if eqInt (lengthArray foreignNodeIds) 0 then outline
    else
      case findNode closingNodeId outline of
        Nothing -> outline
        Just closingNode ->
          let
            detached = foldlArray (\current foreignNodeId -> detachNode foreignNodeId current) outline foreignNodeIds
            withParents = foldlArray
              (\current foreignNodeId ->
                case findNode foreignNodeId current of
                  Nothing -> current
                  Just foreignNode -> replaceNode current (foreignNode { parentId = closingNode.parentId }))
              detached
              foreignNodeIds
          in
            case closingNode.parentId of
              Nothing ->
                let insertionIndex = addInt (indexOfNodeId closingNodeId withParents.rootIds) 1 in
                  withParents { rootIds = insertNodeIdsAt foreignNodeIds insertionIndex withParents.rootIds }
              Just parentId ->
                let
                  parent = requireNodeOr parentId withParents (emptyTabNode parentId)
                  insertionIndex = addInt (indexOfNodeId closingNodeId parent.childIds) 1
                in
                  replaceNode withParents (parent { childIds = insertNodeIdsAt foreignNodeIds insertionIndex parent.childIds })

foreignLiveWindowRootsInSubtree :: NodeId -> WindowId -> Outline -> Array NodeId
foreignLiveWindowRootsInSubtree closingNodeId closingRuntimeWindowId outline =
  case findNode closingNodeId outline of
    Nothing -> []
    Just node -> foldlArray (\ids childId -> appendArray ids (foreignLiveWindowRootsFrom childId closingRuntimeWindowId outline)) [] node.childIds

foreignLiveWindowRootsFrom :: NodeId -> WindowId -> Outline -> Array NodeId
foreignLiveWindowRootsFrom nodeId closingRuntimeWindowId outline =
  case findNode nodeId outline of
    Nothing -> []
    Just node ->
      case node.liveWindowId of
        Just liveWindowId ->
          if andBoolean (isLiveWindowNode node) (notBoolean (windowIdEq liveWindowId closingRuntimeWindowId)) then [node.id]
          else foldlArray (\ids childId -> appendArray ids (foreignLiveWindowRootsFrom childId closingRuntimeWindowId outline)) [] node.childIds
        Nothing -> foldlArray (\ids childId -> appendArray ids (foreignLiveWindowRootsFrom childId closingRuntimeWindowId outline)) [] node.childIds

deleteNodes :: Array NodeId -> Outline -> Outline
deleteNodes ids outline =
  let
    nodes = filterArray (\node -> notBoolean (anyArray (\id -> nodeIdEq id node.id) ids)) outline.nodes
    rootIds = filterArray (\id -> notBoolean (anyArray (\deletedId -> nodeIdEq deletedId id) ids)) outline.rootIds
    cleaned = { rootIds: rootIds, nodes: nodes }
  in
    cleaned { nodes = mapArray (\node -> node { childIds = filterArray (\childId -> notBoolean (anyArray (\id -> nodeIdEq id childId) ids)) node.childIds }) cleaned.nodes }

deleteLiveTabNodePromotingChildren :: NodeId -> Outline -> Outline
deleteLiveTabNodePromotingChildren nodeId outline =
  case findNode nodeId outline of
    Nothing -> outline
    Just node ->
      let
        insertionIndex = case node.parentId of
          Nothing -> indexOfNodeId node.id outline.rootIds
          Just parentId -> indexOfNodeId node.id (requireNodeOr parentId outline (emptyTabNode parentId)).childIds
        withoutNode = removeSingleNode nodeId outline
        withChildrenParent = withoutNode { nodes = mapArray (\candidate ->
          if anyArray (\childId -> nodeIdEq childId candidate.id) node.childIds then candidate { parentId = node.parentId }
          else candidate) withoutNode.nodes }
      in
        case node.parentId of
          Nothing -> withChildrenParent { rootIds = insertNodeIdsAt node.childIds insertionIndex withChildrenParent.rootIds }
          Just parentId -> replaceNode withChildrenParent
            ((requireNodeOr parentId withChildrenParent (emptyTabNode parentId))
              { childIds = insertNodeIdsAt node.childIds insertionIndex (requireNodeOr parentId withChildrenParent (emptyTabNode parentId)).childIds })

removeSingleNode :: NodeId -> Outline -> Outline
removeSingleNode nodeId outline =
  { rootIds: removeNodeId nodeId outline.rootIds
  , nodes: mapArray (\node -> node { childIds = removeNodeId nodeId node.childIds })
      (filterArray (\node -> notBoolean (nodeIdEq node.id nodeId)) outline.nodes)
  }

insertNodeIdsAt :: Array NodeId -> Int -> Array NodeId -> Array NodeId
insertNodeIdsAt nodeIds targetIndex values =
  let
    cleaned = foldlArray (\current nodeId -> removeNodeId nodeId current) values nodeIds
    inserted = foldlWithIndexArray
      (\index acc item -> if eqInt index targetIndex then appendArray (appendArray acc nodeIds) [item] else snocArray acc item)
      []
      cleaned
  in
    if eqInt targetIndex (lengthArray cleaned) then appendArray inserted nodeIds else inserted

closeOutlineWindowsMissingFromRuntime :: Array RuntimeWindow -> Outline -> Outline
closeOutlineWindowsMissingFromRuntime runtimeWindows outline =
  foldlArray (\current node ->
    case node.liveWindowId of
      Just windowId ->
        if andBoolean (isLiveWindowNode node) (notBoolean (anyArray (\window -> windowIdEq window.id windowId) runtimeWindows)) then
          closeMissingOutlineWindow node.id windowId current
        else current
      Nothing -> current) outline outline.nodes

closeMissingOutlineWindow :: NodeId -> WindowId -> Outline -> Outline
closeMissingOutlineWindow nodeId windowId outline =
  let
    promoted = promoteForeignLiveWindowsAfterClosingWindow nodeId windowId outline
  in
    case findNode nodeId promoted of
      Nothing -> promoted
      Just node ->
        if eqInt (lengthArray node.childIds) 0 then removeSingleNode nodeId promoted
        else markClosedSubtreeById nodeId 0 promoted

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
      , closedBy: node.restoreClosedBy
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
      bindResult (resolveTabSelector step tabSelector model) (\tab -> requireOutlineNode step (liveTabNodeIdForRuntimeTab tab.id model.outline) model.outline)
    NodeByWindow windowSelector ->
      bindResult (resolveWindowSelector step windowSelector model) (\window -> requireOutlineNode step (liveWindowNodeIdForRuntimeWindow window.id model.outline) model.outline)

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
  reindexAllRuntimeTabs (insertRuntimeTabAt (mapArray (\candidate ->
    if windowIdEq candidate.windowId tab.windowId then
      let
        bumped = if notBoolean (lessThanInt candidate.index tab.index) then candidate { index = addInt candidate.index 1 } else candidate
      in
        if tab.active then bumped { active = false } else bumped
    else candidate) tabs) tab tab.windowId tab.index)

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

moveRuntimeTabSubtree :: NodeId -> TabId -> WindowId -> Int -> Outline -> Array RuntimeTab -> Array RuntimeTab
moveRuntimeTabSubtree nodeId selectedTabId targetWindowId targetIndex outline tabs =
  let
    subtreeTabIds = liveTabIdsInSubtreeExcludingNestedLiveWindows nodeId outline
    remainingTabIds = filterArray (\tabId -> notBoolean (tabIdEq tabId selectedTabId)) subtreeTabIds
    withSelected = moveRuntimeTab selectedTabId targetWindowId targetIndex tabs
  in
    foldlWithIndexArray
      (\index current tabId -> moveRuntimeTab tabId targetWindowId (addInt targetIndex (addInt index 1)) current)
      withSelected
      remainingTabIds

syncRuntimeOrderFromOutline :: Outline -> Array RuntimeTab -> Array RuntimeTab
syncRuntimeOrderFromOutline outline tabs =
  foldlArray (\current windowNode ->
    case windowNode.liveWindowId of
      Nothing -> current
      Just windowId ->
        let tabIds = liveTabIdsAlreadyInRuntimeWindow windowNode.id windowId outline in
          if eqInt (lengthArray tabIds) 0 then current
          else reindexAllRuntimeTabs (moveRuntimeTabsToWindowInOrder tabIds windowId 0 current))
    tabs
    (liveWindowNodesInVisibleOrder outline)

syncRuntimeOrderFromOpenOutlineWindows :: Outline -> Array RuntimeWindow -> Array RuntimeTab -> Array RuntimeTab
syncRuntimeOrderFromOpenOutlineWindows outline runtimeWindows tabs =
  foldlArray (\current windowNode ->
    case windowNode.liveWindowId of
      Nothing -> current
      Just windowId ->
        if notBoolean (runtimeWindowIsOpen windowId runtimeWindows) then current
        else
          let tabIds = liveTabIdsAlreadyInRuntimeWindow windowNode.id windowId outline in
            if eqInt (lengthArray tabIds) 0 then current
            else reindexAllRuntimeTabs (moveRuntimeTabsToWindowInOrder tabIds windowId 0 current))
    tabs
    (liveWindowNodesInVisibleOrder outline)

refreshOutlineDirectLiveTabOrderFromRuntime :: Array RuntimeTab -> Outline -> Outline
refreshOutlineDirectLiveTabOrderFromRuntime runtimeTabs outline =
  foldlArray
    (\current windowNode ->
      case windowNode.liveWindowId of
        Nothing -> current
        Just windowId ->
          if isLiveWindowNode windowNode then reorderDirectLiveTabChildrenForWindow windowNode.id windowId runtimeTabs current
          else current)
    outline
    (liveWindowNodesInVisibleOrder outline)

reorderDirectLiveTabChildrenForWindow :: NodeId -> WindowId -> Array RuntimeTab -> Outline -> Outline
reorderDirectLiveTabChildrenForWindow parentId windowId runtimeTabs outline =
  case findNode parentId outline of
    Nothing -> outline
    Just parent ->
      replaceNode outline (parent { childIds = sortDirectChildRankRuns parent.childIds windowId runtimeTabs outline })

sortDirectChildRankRuns :: Array NodeId -> WindowId -> Array RuntimeTab -> Outline -> Array NodeId
sortDirectChildRankRuns childIds windowId runtimeTabs outline =
  let
    state = foldlArray
      (\current childId ->
        if directChildHasRuntimeRank childId windowId runtimeTabs outline then
          current { run = snocArray current.run childId }
        else
          let sortedRun = sortDirectChildIdsByRuntimeRank current.run windowId runtimeTabs outline in
            { childIds: snocArray (appendArray current.childIds sortedRun) childId, run: [] })
      { childIds: [], run: [] }
      childIds
  in
    appendArray state.childIds (sortDirectChildIdsByRuntimeRank state.run windowId runtimeTabs outline)

directChildHasRuntimeRank :: NodeId -> WindowId -> Array RuntimeTab -> Outline -> Boolean
directChildHasRuntimeRank childId windowId runtimeTabs outline =
  case minimumRuntimeRankInSubtree childId windowId runtimeTabs outline of
    Nothing -> false
    Just _ -> true

sortDirectChildIdsByRuntimeRank :: Array NodeId -> WindowId -> Array RuntimeTab -> Outline -> Array NodeId
sortDirectChildIdsByRuntimeRank childIds windowId runtimeTabs outline =
  foldlArray
    (\sorted childId -> insertDirectChildIdByRuntimeRank childId windowId runtimeTabs outline sorted)
    []
    childIds

insertDirectChildIdByRuntimeRank :: NodeId -> WindowId -> Array RuntimeTab -> Outline -> Array NodeId -> Array NodeId
insertDirectChildIdByRuntimeRank childId windowId runtimeTabs outline sorted =
  let
    childRank = directChildRuntimeRankOrEnd childId windowId runtimeTabs outline
    inserted = foldlArray
      (\current candidateId ->
        if current.inserted then current { childIds = snocArray current.childIds candidateId }
        else
          let candidateRank = directChildRuntimeRankOrEnd candidateId windowId runtimeTabs outline in
            if lessThanInt childRank candidateRank then
              { inserted: true, childIds: snocArray (snocArray current.childIds childId) candidateId }
            else current { childIds = snocArray current.childIds candidateId })
      { inserted: false, childIds: [] }
      sorted
  in
    if inserted.inserted then inserted.childIds
    else snocArray inserted.childIds childId

directChildRuntimeRankOrEnd :: NodeId -> WindowId -> Array RuntimeTab -> Outline -> Int
directChildRuntimeRankOrEnd childId windowId runtimeTabs outline =
  maybe (lengthArray runtimeTabs) identityInt (minimumRuntimeRankInSubtree childId windowId runtimeTabs outline)

minimumRuntimeRankInSubtree :: NodeId -> WindowId -> Array RuntimeTab -> Outline -> Maybe Int
minimumRuntimeRankInSubtree nodeId windowId tabs outline =
  case findNode nodeId outline of
    Nothing -> Nothing
    Just node ->
      let
        selfRank =
          case node.liveTabId of
            Nothing -> Nothing
            Just tabId ->
              case node.liveWindowId of
                Just tabWindowId ->
                  if andBoolean (isLiveTabNode node) (windowIdEq tabWindowId windowId) then runtimeRankForTabId tabs tabId
                  else Nothing
                Nothing -> Nothing
      in
        foldlArray
          (\rank childId -> minMaybeInt rank (minimumRuntimeRankInSubtree childId windowId tabs outline))
          selfRank
          node.childIds

runtimeRankForTabId :: Array RuntimeTab -> TabId -> Maybe Int
runtimeRankForTabId tabs tabId =
  foldlWithIndexArray
    (\index found tab ->
      case found of
        Just _ -> found
        Nothing -> if tabIdEq tab.id tabId then Just index else Nothing)
    Nothing
    tabs

minMaybeInt :: Maybe Int -> Maybe Int -> Maybe Int
minMaybeInt left right =
  case left of
    Nothing -> right
    Just leftValue ->
      case right of
        Nothing -> left
        Just rightValue -> Just (minInt leftValue rightValue)

moveRuntimeTabsToWindowInOrder :: Array TabId -> WindowId -> Int -> Array RuntimeTab -> Array RuntimeTab
moveRuntimeTabsToWindowInOrder tabIds windowId startIndex tabs =
  foldlWithIndexArray
    (\index current tabId -> moveRuntimeTab tabId windowId (addInt startIndex index) current)
    tabs
    tabIds

insertRuntimeTabAt :: Array RuntimeTab -> RuntimeTab -> WindowId -> Int -> Array RuntimeTab
insertRuntimeTabAt tabs moved targetWindowId targetIndex =
  let
    targetTabs = insertAtIndex moved targetIndex (tabsInWindowFrom tabs targetWindowId)
    reindexedTargetTabs = mapWithIndexArray (\index tab -> tab { index = index }) targetTabs
  in
    appendArray
      (filterArray (\tab -> notBoolean (windowIdEq tab.windowId targetWindowId)) tabs)
      reindexedTargetTabs

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

applyCommandMoveActiveState :: TabId -> Boolean -> Array RuntimeTab -> Array RuntimeTab
applyCommandMoveActiveState movedTabId active tabs =
  mapArray (\tab -> if tabIdEq tab.id movedTabId then tab { active = active } else tab) tabs

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

clearActiveWindowsInOutline :: Outline -> Outline
clearActiveWindowsInOutline outline =
  outline { nodes = mapArray (\node -> if isLiveWindowNode node then node { active = Just false } else node) outline.nodes }

setActiveWindowInOutlineIfFocused :: Array RuntimeWindow -> Outline -> Outline
setActiveWindowInOutlineIfFocused windows outline =
  case findArray (\window -> window.focused) windows of
    Nothing -> outline
    Just window -> setActiveWindowInOutline window.id outline

updateLiveTabMetadata :: RuntimeTab -> Outline -> Outline
updateLiveTabMetadata tab outline =
  let
    nodeId = liveTabNodeIdForRuntimeTab tab.id outline
    node = requireNodeOr nodeId outline (emptyTabNode nodeId)
  in
  replaceNode outline
    (node
      { title = runtimeTabTitleForOutlineNode node tab
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

insertChildAt :: NodeId -> NodeId -> Int -> Outline -> Outline
insertChildAt parentId childId index outline =
  let
    parent = requireNodeOr parentId outline (emptyTabNode parentId)
  in
    replaceNode outline (parent { childIds = insertNodeIdAt childId index parent.childIds })

insertChildBefore :: NodeId -> NodeId -> NodeId -> Outline -> Outline
insertChildBefore parentId childId beforeChildId outline =
  insertChildAt parentId childId (indexOfNodeId beforeChildId (requireNodeOr parentId outline (emptyTabNode parentId)).childIds) outline

insertNodeIdAt :: NodeId -> Int -> Array NodeId -> Array NodeId
insertNodeIdAt nodeId targetIndex values =
  let
    cleaned = removeNodeId nodeId values
    inserted = foldlWithIndexArray
      (\index acc item -> if eqInt index targetIndex then snocArray (snocArray acc nodeId) item else snocArray acc item)
      []
      cleaned
  in
    snocIfEnd nodeId targetIndex cleaned inserted

detachNode :: NodeId -> Outline -> Outline
detachNode nodeId outline =
  let withoutChild = outline { rootIds = removeNodeId nodeId outline.rootIds, nodes = mapArray (\node -> node { childIds = removeNodeId nodeId node.childIds }) outline.nodes } in
    case findNode nodeId withoutChild of
      Nothing -> withoutChild
      Just node -> replaceNode withoutChild (node { parentId = Nothing })

findNode :: NodeId -> Outline -> Maybe OutlineNode
findNode nodeId outline =
  findArray (\node -> nodeIdEq node.id nodeId) outline.nodes

liveWindowNodeIdForRuntimeWindow :: WindowId -> Outline -> NodeId
liveWindowNodeIdForRuntimeWindow windowId outline =
  case findArray (\node ->
    case node.liveWindowId of
      Just liveWindowId -> andBoolean (isLiveWindowNode node) (windowIdEq liveWindowId windowId)
      Nothing -> false) outline.nodes of
    Nothing -> windowNodeId windowId
    Just node -> node.id

liveTabNodeIdForRuntimeTab :: TabId -> Outline -> NodeId
liveTabNodeIdForRuntimeTab tabId outline =
  case findArray (\node ->
    case node.liveTabId of
      Just liveTabId -> andBoolean (isLiveTabNode node) (tabIdEq liveTabId tabId)
      Nothing -> false) outline.nodes of
    Nothing -> tabNodeId tabId
    Just node -> node.id

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
  , restoreClosedBy: Nothing
  , runtimeProvenance: Nothing
  , restoredFromClosed: false
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

subtreeNodeIdsExcludingNestedLiveWindows :: NodeId -> Outline -> Array NodeId
subtreeNodeIdsExcludingNestedLiveWindows nodeId outline =
  subtreeNodeIdsExcludingNestedLiveWindowsFrom nodeId nodeId outline

subtreeNodeIdsExcludingNestedLiveWindowsFrom :: NodeId -> NodeId -> Outline -> Array NodeId
subtreeNodeIdsExcludingNestedLiveWindowsFrom rootId nodeId outline =
  case findNode nodeId outline of
    Nothing -> []
    Just node ->
      if andBoolean (notBoolean (nodeIdEq nodeId rootId)) (isLiveWindowNode node) then []
      else
        let
          childNodeIds = foldlArray
            (\ids childId -> appendArray ids (subtreeNodeIdsExcludingNestedLiveWindowsFrom rootId childId outline))
            []
            node.childIds
        in appendArray [node.id] childNodeIds

liveTabIdsInSubtreeExcludingNestedLiveWindows :: NodeId -> Outline -> Array TabId
liveTabIdsInSubtreeExcludingNestedLiveWindows nodeId outline =
  liveTabIdsForNodes (subtreeNodeIdsExcludingNestedLiveWindows nodeId outline) outline

liveTabIdsAlreadyInRuntimeWindow :: NodeId -> WindowId -> Outline -> Array TabId
liveTabIdsAlreadyInRuntimeWindow rootWindowNodeId runtimeWindowId outline =
  mapMaybeArray
    (\nodeId ->
      case findNode nodeId outline of
        Just node ->
          case node.liveTabId of
            Just tabId ->
              case node.liveWindowId of
                Just tabWindowId -> if andBoolean (isLiveTabNode node) (windowIdEq tabWindowId runtimeWindowId) then Just tabId else Nothing
                Nothing -> Nothing
            Nothing -> Nothing
        Nothing -> Nothing)
    (subtreeNodeIdsExcludingNestedLiveWindows rootWindowNodeId outline)

liveWindowIdsForNodes :: Array NodeId -> Outline -> Array WindowId
liveWindowIdsForNodes nodeIds outline =
  mapMaybeArray (\nodeId ->
    case findNode nodeId outline of
      Just node -> if isLiveWindowNode node then node.liveWindowId else Nothing
      Nothing -> Nothing) nodeIds

liveWindowNodesInVisibleOrder :: Outline -> Array OutlineNode
liveWindowNodesInVisibleOrder outline =
  mapMaybeArray
    (\nodeId ->
      case findNode nodeId outline of
        Just node -> if isLiveWindowNode node then Just node else Nothing
        Nothing -> Nothing)
    (foldlArray (\ids rootId -> appendArray ids (subtreeNodeIds rootId outline)) [] outline.rootIds)

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

ensureRuntimeWindowForTab :: RuntimeTab -> Array RuntimeWindow -> Array RuntimeWindow
ensureRuntimeWindowForTab tab windows =
  if anyArray (\window -> windowIdEq window.id tab.windowId) windows then
    windows
  else
    snocArray windows { id: tab.windowId, focused: false, incognito: tab.incognito, state: Nothing }

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

setStaleTabsCapture :: Maybe String -> Array RuntimeTab -> OracleModel -> OracleModel
setStaleTabsCapture maybeName tabs model =
  case maybeName of
    Nothing -> model
    Just name -> model { staleTabCaptures = setPair name tabs model.staleTabCaptures }

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

lastArray :: forall a. Array a -> Maybe a
lastArray values =
  indexArray (subInt (lengthArray values) 1) values

dropLastArray :: forall a. Array a -> Array a
dropLastArray values =
  let lastIndex = subInt (lengthArray values) 1 in
    foldlWithIndexArray
      (\index acc value -> if lessThanInt index lastIndex then snocArray acc value else acc)
      []
      values

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

decodeOptionalArray :: forall a. (Json -> Result a) -> String -> Json -> Result (Array a)
decodeOptionalArray decoder key json =
  case fieldArray key json of
    Nothing -> Ok []
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

runtimeTabTitleForOutlineNode :: OutlineNode -> RuntimeTab -> String
runtimeTabTitleForOutlineNode node tab =
  let title = runtimeTabTitle tab in
    if andBoolean node.restoredFromClosed (isTransientRestoredRuntimeTitle title tab.url) then node.title
    else title

isTransientRestoredRuntimeTitle :: String -> Maybe String -> Boolean
isTransientRestoredRuntimeTitle title url =
  isTransientRestoredRuntimeTitleImpl title (maybe "" identityString url)

isBlankRuntimeTabUrl :: Maybe String -> Boolean
isBlankRuntimeTabUrl url =
  case url of
    Nothing -> true
    Just value -> orBoolean (eqString value "about:blank") (eqString value "about:newtab")

isLiveStatus :: NodeStatus -> Boolean
isLiveStatus status =
  case status of
    LiveStatus -> true
    ClosedStatus -> false
    NeutralStatus -> false

isClosedStatus :: NodeStatus -> Boolean
isClosedStatus status =
  case status of
    ClosedStatus -> true
    LiveStatus -> false
    NeutralStatus -> false

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

maybeNodeIdEq :: Maybe NodeId -> Maybe NodeId -> Boolean
maybeNodeIdEq left right =
  case left of
    Nothing -> case right of
      Nothing -> true
      Just _ -> false
    Just leftId -> case right of
      Nothing -> false
      Just rightId -> nodeIdEq leftId rightId

maybeWindowIdEq :: Maybe WindowId -> Maybe WindowId -> Boolean
maybeWindowIdEq left right =
  case left of
    Nothing -> case right of
      Nothing -> true
      Just _ -> false
    Just leftId -> case right of
      Nothing -> false
      Just rightId -> windowIdEq leftId rightId

nodeIdInArray :: NodeId -> Array NodeId -> Boolean
nodeIdInArray nodeId values =
  anyArray (\candidate -> nodeIdEq candidate nodeId) values

appendMissingNodeIds :: Array NodeId -> Array NodeId -> Array NodeId
appendMissingNodeIds values additional =
  foldlArray
    (\ids nodeId -> if nodeIdInArray nodeId ids then ids else snocArray ids nodeId)
    values
    additional

removeNodeId :: NodeId -> Array NodeId -> Array NodeId
removeNodeId nodeId values =
  filterArray (\candidate -> notBoolean (nodeIdEq candidate nodeId)) values

indexOfNodeId :: NodeId -> Array NodeId -> Int
indexOfNodeId nodeId values =
  maybe (lengthArray values) identityInt (findIndexArray (\candidate -> nodeIdEq candidate nodeId) values)

identityBoolean :: Boolean -> Boolean
identityBoolean value = value

identityInt :: Int -> Int
identityInt value = value

identityString :: String -> String
identityString value = value

identityTabId :: TabId -> TabId
identityTabId value = value

identityWindowId :: WindowId -> WindowId
identityWindowId value = value

oracleError :: Maybe Int -> String -> String -> OracleError
oracleError step code message =
  { step: step, code: code, message: message }

oracleStepError :: Int -> String -> String -> OracleError
oracleStepError step code message =
  oracleError (Just step) code message
