<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import FilterBar from '../components/common/FilterBar.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import type { DevRecipe } from '../types/dev-recipe'
import type { DevRun, TankType } from '../types/dev-run'
import type { Developer } from '../types/developer'
import { remainingRolls } from '../utils/ratio'

interface FilterValue {
  keyword: string
  selections: Record<string, string[]>
}

interface RunForm {
  batchNo: string
  recipeId: number
  developerId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

const route = useRoute()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const showForm = ref(false)
const saving = ref(false)
const today = new Date().toISOString().slice(0, 10)

const querySelections = (key: string): string[] => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value.split(',') : []
}

const filterValue = ref<FilterValue>({
  keyword: typeof route.query.q === 'string' ? route.query.q : '',
  selections: {
    tankType: querySelections('tankType'),
    result: querySelections('result')
  }
})

const form = reactive<RunForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  developerId: 0,
  actualTempC: 20,
  actualMinutes: 8,
  tankType: '双联罐',
  runDate: today,
  result: '密度均匀，中间调细腻'
})

const selectedRecipe = computed(() => recipeStore.recipes.find((recipe) => recipe.id === form.recipeId))
const recipeDeveloper = computed(() =>
  developerStore.developers.find((item) => item.id === selectedRecipe.value?.developerId)
)
// 报废或余量用完的工作液不可选用
const usableDevelopers = computed(() => developerStore.developers.filter((developer) =>
  developer.state !== '报废' && remainingRolls(developer.maxRolls, developer.usedRolls) > 0
))
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)
const { suggest } = useTempCompensate(referenceTemp)
const suggestion = computed(() => {
  const recipe = selectedRecipe.value
  if (!recipe) return null
  return suggest(recipe.devMinutes, form.actualTempC)
})

function defaultDeveloperId(recipe: DevRecipe | undefined): number {
  if (!recipe) return 0
  const usable = usableDevelopers.value
  const own = usable.find((item) => item.id === recipe.developerId)
  if (own?.id !== undefined) return own.id
  const expected = developerStore.developers.find((item) => item.id === recipe.developerId)
  const matching = usable.find((item) =>
    item.category === expected?.category && item.dilution === recipe.dilution
  )
  return matching?.id ?? 0
}

watch(selectedRecipe, (recipe) => {
  if (!recipe) return
  form.actualTempC = recipe.tempC
  form.actualMinutes = recipe.devMinutes
  form.developerId = defaultDeveloperId(recipe)
}, { immediate: true })

const filteredRuns = computed(() => {
  const keyword = filterValue.value.keyword.trim().toLowerCase()
  const tankTypes = filterValue.value.selections.tankType ?? []
  const results = filterValue.value.selections.result ?? []
  return runStore.runs.filter((run) => {
    const recipe = recipeStore.recipes.find((item) => item.id === run.recipeId)
    const film = filmStore.films.find((item) => item.id === recipe?.filmId)
    const haystack = `${run.batchNo} ${run.result} ${film?.model ?? ''}`.toLowerCase()
    const matchesKeyword = !keyword || haystack.includes(keyword)
    const matchesTank = tankTypes.length === 0 || tankTypes.includes(run.tankType)
    const matchesResult = results.length === 0 || results.some((item) => run.result.includes(item))
    return matchesKeyword && matchesTank && matchesResult
  })
})

function recipeLabel(id: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === id)
  if (!recipe) return '未知配方'
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  const developer = developerStore.developers.find((item) => item.id === recipe.developerId)
  return `${film?.model ?? '未知胶片'} · ${developer?.name ?? '未知显影液'} · ${recipe.tempC}°C`
}

function recipeForRun(id: number) {
  return recipeStore.recipes.find((item) => item.id === id)
}

// 新记录按实冲所选工作液展示；旧记录没有工作液编号时回退到配方关联的工作液
function developerForRun(run: DevRun): Developer | undefined {
  const developerId = run.developerId ?? recipeForRun(run.recipeId)?.developerId
  return developerStore.developers.find((item) => item.id === developerId)
}

function validateDeveloper(recipe: DevRecipe, developer: Developer): string | null {
  if (developer.state === '报废') return `「${developer.name}」已报废，不能用于实冲`
  if (remainingRolls(developer.maxRolls, developer.usedRolls) === 0) {
    return `「${developer.name}」余量已用完，不能用于实冲`
  }
  if (recipeDeveloper.value && developer.category !== recipeDeveloper.value.category) {
    return `工作液类别与配方不一致：配方要求 ${recipeDeveloper.value.category}，所选为 ${developer.category}`
  }
  if (developer.dilution !== recipe.dilution) {
    return `工作液稀释比与配方不一致：配方要求 ${recipe.dilution}，所选为 ${developer.dilution}`
  }
  return null
}

function applySuggestion(): void {
  if (!suggestion.value) return
  form.actualMinutes = suggestion.value.minutes
}

async function submitRun(): Promise<void> {
  if (!form.batchNo.trim() || !form.recipeId || !form.result.trim()) {
    ElMessage.warning('请填写批次号、配方与结果评价')
    return
  }
  const recipe = selectedRecipe.value
  if (!recipe) {
    ElMessage.warning('请选择冲洗配方')
    return
  }
  const developer = developerStore.developers.find((item) => item.id === form.developerId)
  if (!developer) {
    ElMessage.warning('请选择本次实际使用的工作液')
    return
  }
  const mismatch = validateDeveloper(recipe, developer)
  if (mismatch) {
    ElMessage.error(mismatch)
    return
  }
  saving.value = true
  const willAutoScrap = developer.usedRolls + 1 >= developer.maxRolls
  try {
    await runStore.addRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      developerId: Number(form.developerId),
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      tankType: form.tankType,
      runDate: form.runDate,
      result: form.result.trim()
    })
    await Promise.all([developerStore.load(), recipeStore.load()])
    if (willAutoScrap) {
      ElMessage.warning(`冲洗记录已保存，「${developer.name}」已达可冲上限并自动报废`)
    } else {
      ElMessage.success('冲洗记录已保存，所选工作液用量已加一卷')
    }
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    form.result = ''
    form.developerId = defaultDeveloperId(recipe)
    showForm.value = false
  } finally {
    saving.value = false
  }
}

async function writeBack(recipeId?: number, runId?: number): Promise<void> {
  if (recipeId === undefined || runId === undefined) return
  await runStore.writeBackNote(runId, recipeId)
  await recipeStore.load()
  ElMessage.success('本次实冲结果已回写配方注释')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load(), runStore.load()])
  if (recipeStore.recipes[0]?.id !== undefined) {
    form.recipeId = recipeStore.recipes[0].id
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗记录与结果评价</h1>
        <p>记录每一次实测温度、实际时间与样片结果，让下一批参数来自真实经验。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建冲洗记录' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="submitRun">
      <div class="inline-form__head">
        <div>
          <h2>录入本次实冲</h2>
          <p>选择配方后自动带入基准条件，请再指定本次实际使用的工作液，保存时只扣该瓶寿命。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>冲洗配方</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeStore.recipes" :key="recipe.id" :value="recipe.id">
              {{ recipeLabel(recipe.id ?? 0) }}
            </option>
          </select>
        </label>
        <label class="span-2">
          <span>实际使用工作液</span>
          <select v-model.number="form.developerId" data-testid="field-developerId">
            <option :value="0" disabled>请选择工作液</option>
            <option v-for="developer in usableDevelopers" :key="developer.id" :value="developer.id">
              {{ developer.name }} · {{ developer.category }} {{ developer.dilution }} · 余 {{ remainingRolls(developer.maxRolls, developer.usedRolls) }} 卷
            </option>
          </select>
          <small v-if="selectedRecipe">
            配方要求 {{ recipeDeveloper?.category ?? '未知类别' }} · {{ selectedRecipe.dilution }}，报废或已用完的工作液不可选
          </small>
          <small v-if="usableDevelopers.length === 0">当前没有可用的工作液，请先在「显影液配制与余量」中登记。</small>
        </label>
        <label>
          <span>实测温度</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实际时间</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label class="span-2">
          <span>结果评价</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="记录反差、灰雾与密度表现" />
        </label>
        <div class="span-3 compensation-callout">
          <div>
            <strong>温度补偿建议</strong>
            <p v-if="suggestion">{{ suggestion.advice }}；保存后给所选工作液加一卷，到达上限自动报废。</p>
            <p v-else>请选择一条配方后查看修正建议。</p>
          </div>
          <button type="button" class="ghost-button" :disabled="!suggestion" @click="applySuggestion">采用修正时间</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-run" :disabled="saving">
          {{ saving ? '保存中…' : '保存冲洗记录' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>记录总数</span><strong data-testid="count-run">{{ runStore.runs.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>当前筛选</span><strong>{{ filteredRuns.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>回写配方</span><strong>{{ recipeStore.recipes.filter((item) => item.note).length }}</strong><small>条</small></div>
    </div>

    <FilterBar
      v-model="filterValue"
      :fields="[
        { key: 'tankType', label: '罐型', options: ['双联罐', '深罐'] },
        { key: 'result', label: '结果特点', options: ['密度均匀', '暗部略薄', '反差稍强', '高光保留', '灰雾'] }
      ]"
    />

    <div v-if="filteredRuns.length" class="run-list">
      <article v-for="run in filteredRuns" :key="run.id" class="run-card" data-testid="row-run">
        <div class="run-card__date">
          <strong>{{ run.runDate.slice(5) }}</strong>
          <span>{{ run.runDate.slice(0, 4) }}</span>
        </div>
        <div class="run-card__body">
          <div class="entity-card__title">
            <div>
              <h2>{{ run.batchNo }}</h2>
              <p>{{ recipeLabel(run.recipeId) }}</p>
            </div>
            <PushPullTag v-if="recipeForRun(run.recipeId)" :value="recipeForRun(run.recipeId)?.pushPull ?? 'N'" />
          </div>
          <div class="run-parameters">
            <span><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
            <span><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
            <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
            <span><small>工作液</small><strong>{{ developerForRun(run)?.name ?? '未知显影液' }}</strong></span>
          </div>
          <blockquote>{{ run.result }}</blockquote>
          <div class="run-card__foot">
            <small v-if="recipeForRun(run.recipeId)?.note">配方注释：{{ recipeForRun(run.recipeId)?.note }}</small>
            <button type="button" class="text-button" @click="writeBack(run.recipeId, run.id)">回写配方注释</button>
          </div>
        </div>
      </article>
    </div>
    <EmptyPanel v-else title="没有符合条件的冲洗记录" description="调整罐型、结果特点或关键字后重新查看。" />
  </section>
</template>
