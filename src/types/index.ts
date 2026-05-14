// Core domain types for Foodie

export type Cuisine =
  | 'italian' | 'mexican' | 'chinese' | 'japanese' | 'indian' | 'thai'
  | 'french' | 'american' | 'mediterranean' | 'middle-eastern'
  | 'korean' | 'vietnamese' | 'spanish' | 'greek' | 'caribbean' | 'african' | 'other';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'dessert' | 'snack' | 'drink' | 'appetizer';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type DietaryTag =
  | 'vegetarian' | 'vegan' | 'gluten-free' | 'dairy-free'
  | 'nut-free' | 'low-carb' | 'keto' | 'paleo' | 'whole30' | 'pescatarian';

export interface Ingredient {
  id: string;
  name: string;
  amount: string;       // e.g. "2", "1/2", "to taste"
  unit?: string;        // e.g. "cup", "tbsp", "g"
  notes?: string;       // e.g. "finely chopped"
}

export interface Step {
  id: string;
  order: number;
  text: string;
  timer_seconds?: number;   // optional cooking timer
  tip?: string;             // optional chef's tip
}

export interface NutritionInfo {
  calories?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
}

export interface Recipe {
  id: string;
  slug: string;
  title: string;
  description: string;
  hero_image_url: string;
  cuisine: Cuisine;
  meal_types: MealType[];
  dietary_tags: DietaryTag[];
  difficulty: Difficulty;
  prep_minutes: number;
  cook_minutes: number;
  servings: number;
  ingredients: Ingredient[];
  steps: Step[];
  nutrition?: NutritionInfo;
  author_id: string;
  author_name: string;
  author_avatar_url?: string;
  created_at: string;
  updated_at: string;
  likes_count: number;
  rating_avg: number;
  rating_count: number;
  featured: boolean;
  source_url?: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  created_at: string;
  followers_count: number;
  following_count: number;
  recipes_count: number;
}

export interface SavedRecipe {
  user_id: string;
  recipe_id: string;
  saved_at: string;
  collection?: string;     // e.g. "weeknight", "date night"
}

export interface Rating {
  id: string;
  user_id: string;
  recipe_id: string;
  stars: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  created_at: string;
}

export interface Comment {
  id: string;
  user_id: string;
  user_name: string;
  user_avatar_url?: string;
  recipe_id: string;
  body: string;
  created_at: string;
  parent_id?: string;
  likes_count: number;
}

export interface Follow {
  follower_id: string;
  following_id: string;
  created_at: string;
}

export interface MealPlan {
  id: string;
  user_id: string;
  week_starts_on: string;          // ISO date for the Monday
  entries: MealPlanEntry[];
  created_at: string;
}

export interface MealPlanEntry {
  id: string;
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  meal_type: MealType;
  recipe_id: string;
  servings: number;
  notes?: string;
}

export interface ShoppingListItem {
  id: string;
  user_id: string;
  ingredient_name: string;
  amount?: string;
  unit?: string;
  recipe_id?: string;
  checked: boolean;
  added_at: string;
}

export interface RecipeListFilters {
  cuisine?: Cuisine;
  meal_type?: MealType;
  dietary?: DietaryTag;
  difficulty?: Difficulty;
  max_total_minutes?: number;
  query?: string;
  sort?: 'newest' | 'popular' | 'top-rated' | 'quickest';
}
