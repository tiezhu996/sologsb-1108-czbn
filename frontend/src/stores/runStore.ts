import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addRun(payload: NewRun): Promise<number> {
      const next = { ...payload, schemaRev: 3 }
      const id = await db.runs.add(plain(next))
      // 只扣本次实际选用的那瓶工作液；配方关联的旧瓶不再被动消耗。
      if (payload.developerId !== undefined) {
        const developer = await db.developers.get(payload.developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          const usedRolls = developer.usedRolls + 1
          const state = usedRolls >= developer.maxRolls ? '报废' : '在用'
          await db.developers.update(developer.id, plain({ usedRolls, state }))
        }
      }
      await this.load()
      return id
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
