import './timeline.css'
import { AudioMeter } from './AudioMeter'
import { TimelineTabBar } from './TimelineTabBar'
import { TimelineView } from './TimelineView'
import { Toolbar, useTabBarExpanded } from './Toolbar'

export function TimelinePane() {
  const tabs = useTabBarExpanded()
  return (
    <div className="pp-tl-pane">
      {tabs && <TimelineTabBar />}
      <Toolbar />
      <div className="pp-tl-main">
        <TimelineView />
        <AudioMeter />
      </div>
    </div>
  )
}
